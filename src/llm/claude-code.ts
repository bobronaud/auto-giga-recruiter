import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import type { AppConfig } from "../config/schema.js";
import { actionSchema, type InterviewAction } from "./action.js";
import { TransientBrainError, type Brain, type Usage } from "./brain.js";

// Без поля $schema: валидатор CLI не знает мета-схему draft 2020-12
const { $schema: _ignored, ...actionJsonSchema } = z.toJSONSchema(actionSchema) as Record<string, unknown>;
const ACTION_JSON_SCHEMA = JSON.stringify(actionJsonSchema);
const CALL_TIMEOUT_MS = 5 * 60_000;

/** Ответ `claude -p --output-format json` (нужные нам поля). */
interface CliResult {
  type: string;
  subtype?: string;
  is_error: boolean;
  result?: string;
  session_id?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * «Мозг» на основе Claude Code CLI (`claude -p`): использует твою подписку Claude
 * (Pro/Max), ключ API не нужен. Диалог продолжается через --resume, поэтому
 * история и кэш промпта сохраняются между ходами.
 *
 * Изоляция: без инструментов (--tools ""), без MCP-серверов, без пользовательских
 * настроек и хуков, в отдельной рабочей папке — модель только отвечает на вопросы.
 */
export class ClaudeCodeBrain implements Brain {
  readonly provider = "claude-code" as const;
  readonly usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, costUsd: 0 };
  private readonly sessionId = randomUUID();
  private started = false;

  constructor(
    private readonly llm: AppConfig["llm"],
    private readonly system: string,
    private readonly workDir: string,
  ) {
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
  }

  decide(botTurn: string): Promise<InterviewAction> {
    return this.call(botTurn);
  }

  revise(instruction: string): Promise<InterviewAction> {
    return this.call(`(служебно: ${instruction})`);
  }

  private async call(prompt: string): Promise<InterviewAction> {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      ACTION_JSON_SCHEMA,
      "--system-prompt",
      this.system,
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--model",
      this.llm.model,
      "--effort",
      this.llm.effort,
      ...(this.started ? ["--resume", this.sessionId] : ["--session-id", this.sessionId]),
    ];
    const res = await runCli(args, this.workDir);
    this.started = true;

    this.usage.requests++;
    this.usage.input += res.usage?.input_tokens ?? 0;
    this.usage.output += res.usage?.output_tokens ?? 0;
    this.usage.cacheRead += res.usage?.cache_read_input_tokens ?? 0;
    this.usage.cacheWrite += res.usage?.cache_creation_input_tokens ?? 0;
    this.usage.costUsd = (this.usage.costUsd ?? 0) + (res.total_cost_usd ?? 0);

    if (res.is_error || res.subtype !== "success") throw classifyError(res.result ?? res.subtype ?? "неизвестная ошибка");

    const parsed = actionSchema.safeParse(res.structured_output ?? tryJson(res.result));
    if (!parsed.success) throw new TransientBrainError("Claude Code вернул ответ не по схеме");
    return parsed.data;
  }
}

function tryJson(s: string | undefined): unknown {
  try {
    return s ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
}

function classifyError(message: string): Error {
  const m = message.toLowerCase();
  if (/log ?in|not logged|invalid api key|authenticat|oauth/.test(m)) {
    return new Error(`Claude Code не авторизован. Запусти в терминале: claude  и войди через /login (подписка Claude). Детали: ${message}`);
  }
  if (/usage limit|limit reached|out of (usage|credits)|quota/.test(m)) {
    return new Error(`Исчерпан лимит подписки Claude. Подожди сброса лимита или переключись на API. Детали: ${message}`);
  }
  if (/model/.test(m) && /not (found|available)|invalid|access/.test(m)) {
    return new Error(`Модель недоступна на твоём тарифе: поменяй llm.model в config.yaml (например, claude-sonnet-5). Детали: ${message}`);
  }
  if (/overload|timeout|timed out|529|503|500|network|econn|rate/.test(m)) return new TransientBrainError(message);
  return new Error(message);
}

function runCli(args: string[], cwd: string): Promise<CliResult> {
  // Без ключей API в окружении: CLI должен работать через вход по подписке
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new TransientBrainError("Claude Code не ответил за 5 минут"));
    }, CALL_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(new Error("Claude Code CLI не найден. Установи его (https://claude.com/claude-code) и войди: claude → /login"));
      } else reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split("\n").reverse().find((l) => l.startsWith("{"));
      if (line) {
        try {
          return resolve(JSON.parse(line) as CliResult);
        } catch {
          /* ниже — общий текст ошибки */
        }
      }
      reject(classifyError(`claude завершился с кодом ${code}: ${(stderr || stdout).trim().slice(0, 500)}`));
    });
  });
}
