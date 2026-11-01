import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/config/schema.js";
import { TransientBrainError } from "../src/llm/brain.js";
import { CodexBrain } from "../src/llm/codex.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const action = (kind = "reply", text = "Есть опыт TypeScript") => ({ action: kind, text, button_index: -1, reason: "test" });
const output = (answer: unknown = action()) => [
  { type: "thread.started", thread_id: "synthetic" },
  { type: "item.completed", item: { type: "reasoning", text: "не ответ" } },
  { type: "item.completed", item: { type: "agent_message", text: typeof answer === "string" ? answer : JSON.stringify(answer) } },
  { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 20 } },
].map((e) => JSON.stringify(e)).join("\n");

function childProcess() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}

let root: string;
beforeEach(async () => {
  spawnMock.mockReset();
  root = await mkdtemp(join(tmpdir(), "agr-codex-test-"));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function brain(llm = configSchema.parse({}).llm) {
  return new CodexBrain(llm, "Синтетическое резюме кандидата", root);
}

function mockResult(stdout = output(), code: number | null = 0, stderr = "") {
  const child = childProcess();
  const input: string[] = [];
  child.stdin.on("data", (chunk) => input.push(String(chunk)));
  child.stdin.on("finish", () => {
    // Разрыв посреди JSON и UTF-8-последовательности, последняя строка без newline.
    const bytes = Buffer.from(stdout);
    const split = bytes.indexOf(Buffer.from("Есть")) + 1;
    child.stdout.write(bytes.subarray(0, split > 0 ? split : 13));
    child.stdout.write(bytes.subarray(split > 0 ? split : 13));
    child.stderr.write(stderr);
    child.emit("close", code);
  });
  spawnMock.mockReturnValueOnce(child);
  return { child, input };
}

describe("CodexBrain", () => {
  it("вызывает изолированный codex exec, передаёт историю в stdin и считает usage", async () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-api-key");
    vi.stubEnv("CODEX_API_KEY", "synthetic-api-key");
    vi.stubEnv("TG_API_HASH", "synthetic-telegram-hash");
    vi.stubEnv("SESSION_PASSPHRASE", "synthetic-passphrase");
    const run = mockResult();
    const b = brain();
    expect(await b.decide("Какой у вас опыт?")).toEqual(action());
    const [command, args, options] = spawnMock.mock.calls[0]!;
    expect(command).toBe("codex");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("read-only");
    expect(args).toContain("shell_tool");
    expect(args).toContain("plugins");
    expect(args).not.toContain("--model");
    expect(args.join(" ")).not.toContain("Синтетическое резюме");
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.env.CODEX_API_KEY).toBeUndefined();
    expect(options.env.TG_API_HASH).toBeUndefined();
    expect(options.env.SESSION_PASSPHRASE).toBeUndefined();
    expect(JSON.parse(run.input.join(""))).toEqual([{ role: "user", content: "Какой у вас опыт?" }]);
    expect(b.usage).toEqual({ input: 100, output: 20, cacheRead: 70, cacheWrite: 0, requests: 1 });
    expect(await readdir(root)).toEqual([]);
  });

  it("передаёт схему и инструкции приватными файлами, модель и effort — флагами", async () => {
    const llm = configSchema.parse({ llm: { model: "test-model", effort: "high" } }).llm;
    const child = childProcess();
    spawnMock.mockImplementationOnce((_command, args, options) => {
      child.stdin.on("finish", () => {
        void (async () => {
          try {
            const schema = args[args.indexOf("--output-schema") + 1];
            expect(JSON.parse(await readFile(schema, "utf8")).additionalProperties).toBe(false);
            const instructions = join(options.cwd, "instructions.md");
            expect(await readFile(instructions, "utf8")).toContain("Синтетическое резюме");
            expect((await stat(instructions)).mode & 0o777).toBe(0o600);
            expect((await stat(options.cwd)).mode & 0o777).toBe(0o700);
            expect(args).toContain("test-model");
            expect(args).toContain('model_reasoning_effort="high"');
            child.stdout.write(output());
            child.emit("close", 0);
          } catch (error) { child.emit("error", error); }
        })();
      });
      return child;
    });
    await expect(brain(llm).decide("Вопрос")).resolves.toEqual(action());
  });

  it("сохраняет успешные ходы и передаёт revise вместе с предыдущим ответом", async () => {
    const b = brain();
    mockResult();
    await b.decide("Первый вопрос");
    const revised = mockResult(output(action("reply", "Короткий ответ")));
    await b.revise("Короче");
    const messages = JSON.parse(revised.input.join(""));
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({ role: "assistant", content: JSON.stringify(action()) });
    expect(messages[2].content).toContain("Короче");
    mockResult(output(action("finish", "")));
    expect((await b.decide("Спасибо")).action).toBe("finish");
    expect(b.usage.requests).toBe(3);
  });

  it.each(["не JSON", { action: "unknown" }])("повтор после невалидного ответа не дублирует ход: %j", async (invalid) => {
    const b = brain();
    mockResult(output(invalid));
    await expect(b.decide("Вопрос")).rejects.toBeInstanceOf(TransientBrainError);
    const retry = mockResult();
    await b.decide("Вопрос");
    expect(JSON.parse(retry.input.join(""))).toEqual([{ role: "user", content: "Вопрос" }]);
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["click", "wait", "finish"])("сохраняет действие %s", async (kind) => {
    mockResult(output(action(kind, "")));
    expect((await brain().decide("Ход бота")).action).toBe(kind);
  });

  it.each([
    ["401 Unauthorized authentication required", /codex login/],
    ["usage limit reached", /лимит Codex/],
    ["model not available", /llm.model/],
    ["network ECONNRESET", /ECONNRESET/],
  ])("объясняет ошибку CLI: %s", async (message, expected) => {
    mockResult("", 1, message);
    await expect(brain().decide("Вопрос")).rejects.toThrow(expected);
    expect(await readdir(root)).toEqual([]);
  });

  it("не принимает успешный JSON при ненулевом exit code", async () => {
    mockResult(output(), 1, "process failed");
    await expect(brain().decide("Вопрос")).rejects.toThrow(/кодом 1/);
  });

  it("повторяет сетевой сбой с тем же контекстом", async () => {
    const b = brain();
    mockResult();
    await b.decide("Первый вопрос");
    const failed = mockResult(JSON.stringify({ type: "turn.failed", error: { message: "network disconnected" } }), 1);
    await expect(b.decide("Второй вопрос")).rejects.toBeInstanceOf(TransientBrainError);
    const retry = mockResult();
    await b.decide("Второй вопрос");
    expect(retry.input).toEqual(failed.input);
    expect(JSON.parse(retry.input.join(""))).toHaveLength(3);
  });

  it("останавливает процесс при чрезмерном выводе", async () => {
    const child = childProcess();
    child.kill.mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    });
    child.stdin.on("finish", () => child.stdout.write("x".repeat(4 * 1024 * 1024 + 1)));
    spawnMock.mockReturnValueOnce(child);
    await expect(brain().decide("Вопрос")).rejects.toThrow(/превысил допустимый размер/);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    [JSON.stringify({ type: "turn.failed", error: { message: "network disconnected" } }), /network/],
    [JSON.stringify({ type: "error", message: "authentication required" }), /codex login/],
    ['{"broken":', /JSONL/],
    ["", /без финального ответа/],
    [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(action()) } }), /без финального ответа/],
  ])("отклоняет незавершённый или ошибочный поток: %s", async (stdout, expected) => {
    mockResult(stdout);
    await expect(brain().decide("Вопрос")).rejects.toThrow(expected);
  });

  it("объясняет отсутствие исполняемого файла", async () => {
    const child = childProcess();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" })));
      return child;
    });
    await expect(brain().decide("Вопрос")).rejects.toThrow(/npm install -g @openai\/codex/);
    expect(await readdir(root)).toEqual([]);
  });

  it("завершает зависший процесс по таймауту, затем SIGKILL и удаляет временные файлы", async () => {
    const child = childProcess();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    spawnMock.mockImplementationOnce(() => {
      vi.useFakeTimers();
      started();
      return child;
    });
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") child.emit("close", null);
      return true;
    });
    const request = brain().decide("Вопрос");
    const rejected = expect(request).rejects.toThrow(/5 минут/);
    await ready;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await rejected;
    expect(await readdir(root)).toEqual([]);
  });
});
