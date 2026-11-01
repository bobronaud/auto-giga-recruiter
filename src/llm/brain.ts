import type { AppConfig } from "../config/schema.js";
import type { InterviewAction } from "./action.js";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

/** «Мозг» интервью: получает ход бота, возвращает действие. */
export interface Brain {
  readonly provider: "codex";
  readonly usage: Usage;
  decide(botTurn: string): Promise<InterviewAction>;
  revise(instruction: string): Promise<InterviewAction>;
}

/** Модель отказалась отвечать (safety refusal) — можно попробовать ещё раз. */
export class RefusalError extends Error {}

/** Временная ошибка (сеть, перегрузка, таймаут) — стоит повторить. */
export class TransientBrainError extends Error {}

export async function createBrain(cfg: AppConfig, system: string, workDir: string): Promise<Brain> {
  const { CodexBrain } = await import("./codex.js");
  return new CodexBrain(cfg.llm, system, workDir);
}
