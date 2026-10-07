import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import dotenv from "dotenv";
import YAML from "yaml";
import { z } from "zod";
import { configSchema, envSchema, type AppConfig, type AppEnv } from "./schema.js";

export class ConfigError extends Error {}

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

export function loadConfig(path = "config.yaml"): AppConfig & { __source: string } {
  const full = resolve(path);
  let raw: unknown = {};
  let source = "defaults";
  if (existsSync(full)) {
    raw = YAML.parse(readFileSync(full, "utf8")) ?? {};
    source = full;
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Ошибка в ${source}:\n${formatZodError(parsed.error)}`);
  }
  const cfg = parsed.data;
  if (cfg.behavior.typingDelay.minMs > cfg.behavior.typingDelay.maxMs) {
    throw new ConfigError("behavior.typingDelay.minMs не может быть больше maxMs");
  }
  if (cfg.answers.minChars > cfg.answers.maxChars) {
    throw new ConfigError("answers.minChars не может быть больше maxChars");
  }
  if (!isGitIgnored(cfg.logging.dir)) {
    throw new ConfigError(
      `logging.dir «${cfg.logging.dir}» не в .gitignore: там хранятся сессия Telegram и транскрипты. Добавь папку в .gitignore или укажи ./data`,
    );
  }
  return Object.assign(cfg, { __source: source });
}

/**
 * Папка вне git-репозитория или игнорируется им. Без git (не установлен,
 * не репозиторий) проверять нечего — считаем безопасной.
 */
export function isGitIgnored(dir: string): boolean {
  const full = resolve(dir);
  try {
    // check-ignore требует существующий путь внутри рабочего дерева; проверяем файл внутри папки
    execFileSync("git", ["check-ignore", "-q", join(full, ".probe")], { stdio: "ignore", cwd: process.cwd() });
    return true;
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    // 1 — путь не игнорируется; 128 — вне репозитория / нет git; ENOENT — git не установлен
    return status !== 1;
  }
}

export function loadEnv(opts: { requireAnthropic?: boolean; requireTelegramApi?: boolean } = {}): AppEnv {
  dotenv.config({ quiet: true });
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const vars = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    throw new ConfigError(
      `Не заданы или некорректны переменные в .env: ${vars.join(", ")}\n  Создай .env из .env.example (npm start -- init) и заполни его.`,
    );
  }
  if (opts.requireTelegramApi && (!parsed.data.TG_API_ID || !parsed.data.TG_API_HASH)) {
    throw new ConfigError(
      "Для telegram.driver: mtproto нужны TG_API_ID и TG_API_HASH в .env.\n  Если получить их нельзя — используй telegram.driver: web (по умолчанию).",
    );
  }
  if (opts.requireAnthropic && !parsed.data.ANTHROPIC_API_KEY) {
    throw new ConfigError("ANTHROPIC_API_KEY не задан (см. .env.example)");
  }
  return parsed.data;
}
