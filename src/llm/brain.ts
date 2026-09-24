import type { AppConfig, AppEnv } from "../config/schema.js";
import type { InterviewAction } from "./action.js";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
  /** Условная стоимость по прайсу API (для claude-code — оценка CLI; по подписке не списывается) */
  costUsd?: number;
}

/** «Мозг» интервью: получает ход бота, возвращает действие. */
export interface Brain {
  readonly provider: "api" | "claude-code";
  readonly usage: Usage;
  decide(botTurn: string): Promise<InterviewAction>;
  revise(instruction: string): Promise<InterviewAction>;
}

/** Модель отказалась отвечать (safety refusal) — можно попробовать ещё раз. */
export class RefusalError extends Error {}

/** Временная ошибка (сеть, перегрузка, таймаут) — стоит повторить. */
export class TransientBrainError extends Error {}

export type ResolvedProvider = "api" | "claude-code";

/** auto: есть ANTHROPIC_API_KEY → API, иначе Claude Code CLI с подпиской. */
export function resolveProvider(cfg: AppConfig, env: AppEnv): ResolvedProvider {
  if (cfg.llm.provider !== "auto") return cfg.llm.provider;
  return env.ANTHROPIC_API_KEY ? "api" : "claude-code";
}

export async function createBrain(cfg: AppConfig, env: AppEnv, system: string, workDir: string): Promise<Brain> {
  const provider = resolveProvider(cfg, env);
  if (provider === "api") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("llm.provider: api, но ANTHROPIC_API_KEY не задан в .env");
    const { InterviewBrain } = await import("./claude.js");
    return new InterviewBrain(env.ANTHROPIC_API_KEY, cfg.llm, system);
  }
  const { ClaudeCodeBrain } = await import("./claude-code.js");
  return new ClaudeCodeBrain(cfg.llm, system, workDir);
}
