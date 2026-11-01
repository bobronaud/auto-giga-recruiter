import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config/schema.js";
import { redact } from "../util/redact.js";
import { actionSchema, type InterviewAction } from "./action.js";
import { RefusalError, TransientBrainError, type Brain, type Usage } from "./brain.js";

const ACTION_JSON_SCHEMA = JSON.stringify(z.toJSONSchema(actionSchema));
const CALL_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DISABLED_FEATURES = [
  "shell_tool", "shell_snapshot", "apps", "plugins", "hooks", "memories",
  "multi_agent", "browser_use", "computer_use", "view_image", "image_generation", "skill_search",
];

interface CliResult {
  text: string;
  usage: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
}

/** Текстовая генерация через авторизованный Codex CLI; история принадлежит приложению. */
export class CodexBrain implements Brain {
  readonly provider = "codex" as const;
  readonly usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  private readonly history: Array<{ role: "user" | "assistant"; content: string }> = [];

  constructor(
    private readonly llm: AppConfig["llm"],
    private readonly system: string,
    private readonly workDir: string,
  ) {}

  decide(botTurn: string): Promise<InterviewAction> {
    return this.call(botTurn);
  }

  revise(instruction: string): Promise<InterviewAction> {
    return this.call(`(служебно: ${instruction})`);
  }

  private async call(prompt: string): Promise<InterviewAction> {
    const root = resolve(this.workDir);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const cwd = await mkdtemp(join(root, "request-"));
    try {
      const schema = join(cwd, "action.schema.json");
      const instructions = join(cwd, "instructions.md");
      await writeFile(schema, ACTION_JSON_SCHEMA, { mode: 0o600 });
      await writeFile(
        instructions,
        `${this.system}\n\nВ stdin передана история интервью как JSON-массив сообщений с ролями user и assistant. Продолжи её: ответь на последнее сообщение user одним JSON-объектом по заданной схеме. Не используй инструменты.`,
        { mode: 0o600 },
      );
      const args = [
        "exec", "--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
        "--sandbox", "read-only", "--color", "never", "--output-schema", schema,
        "-c", `model_instructions_file=${JSON.stringify(instructions)}`,
        "-c", `model_reasoning_effort=${JSON.stringify(this.llm.effort)}`,
        "-c", "project_doc_max_bytes=0", "-c", 'web_search="disabled"',
        ...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
        ...(this.llm.model ? ["--model", this.llm.model] : []),
        "-",
      ];
      const messages = [...this.history, { role: "user" as const, content: prompt }];
      this.usage.requests++;
      const res = await runCli(args, cwd, JSON.stringify(messages));
      this.usage.input += res.usage.input_tokens ?? 0;
      this.usage.output += res.usage.output_tokens ?? 0;
      this.usage.cacheRead += res.usage.cached_input_tokens ?? 0;
      let value: unknown;
      try {
        value = JSON.parse(res.text);
      } catch {
        throw new TransientBrainError("Codex вернул некорректный JSON");
      }
      const parsed = actionSchema.safeParse(value);
      if (!parsed.success) throw new TransientBrainError("Codex вернул ответ не по схеме");
      // Коммитим историю только после валидного ответа: повтор не дублирует user-ход.
      this.history.push({ role: "user", content: prompt }, { role: "assistant", content: JSON.stringify(parsed.data) });
      return parsed.data;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

function classifyError(message: string): Error {
  const detail = redact(message).slice(0, 500);
  const m = message.toLowerCase();
  if (/log ?in|not logged|unauthorized|authenticat|oauth|401/.test(m)) {
    return new Error(`Codex не авторизован. Выполни codex login и войди через ChatGPT. Детали: ${detail}`);
  }
  if (/usage limit|limit reached|out of (usage|credits)|quota|insufficient_quota/.test(m)) {
    return new Error(`Исчерпан лимит Codex. Дождись сброса лимита. Детали: ${detail}`);
  }
  if (/model/.test(m) && /not (found|available|supported)|invalid|access|does not exist/.test(m)) {
    return new Error(`Модель или effort недоступны. Проверь llm.model и llm.effort в config.yaml. Детали: ${detail}`);
  }
  if (/refusal|refused/.test(m)) return new RefusalError(`Codex отказался отвечать: ${detail}`);
  if (/overload|timeout|timed out|429|50[02349]|network|econn|rate.limit|stream.*disconnect|error sending request/.test(m)) {
    return new TransientBrainError(detail);
  }
  return new Error(`Ошибка Codex: ${detail}`);
}

function runCli(args: string[], cwd: string, prompt: string): Promise<CliResult> {
  const env = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "TG_API_ID", "TG_API_HASH", "SESSION_PASSPHRASE"]) delete env[key];

  return new Promise((resolveResult, reject) => {
    const child = spawn("codex", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let outputBytes = 0;
    let completed = false;
    let failure: Error | undefined;
    const result: CliResult = { text: "", usage: {} };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (error: Error) => {
      failure ??= error;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const timer = setTimeout(() => terminate(new TransientBrainError("Codex не ответил за 5 минут")), CALL_TIMEOUT_MS);

    const consumeLine = (line: string) => {
      if (!line.trim() || failure) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "item.completed" && event.item?.type === "agent_message") result.text = event.item.text;
        if (event.type === "turn.completed") {
          completed = true;
          result.usage = event.usage ?? {};
        }
        if (event.type === "turn.failed") failure = classifyError(event.error?.message ?? "turn.failed");
        if (event.type === "error") failure = classifyError(event.message ?? "неизвестная ошибка");
      } catch {
        failure = new TransientBrainError("Codex вернул некорректный поток JSONL");
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate(new TransientBrainError("Вывод Codex превысил допустимый размер"));
        return;
      }
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        consumeLine(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    // EPIPE возможен, если CLI завершился до чтения stdin; итог берём из close.
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") terminate(new Error("Не удалось передать запрос Codex через stdin"));
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(err.code === "ENOENT"
        ? new Error("Codex CLI не найден. Установи npm install -g @openai/codex и выполни codex login.")
        : new Error(`Не удалось запустить Codex: ${err.code ?? "ошибка процесса"}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      consumeLine(buffer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(classifyError(`codex завершился с кодом ${code}: ${stderr.trim()}`));
      if (!completed || !result.text) return reject(new TransientBrainError("Codex завершился без финального ответа"));
      resolveResult(result);
    });
    child.stdin.end(prompt);
  });
}
