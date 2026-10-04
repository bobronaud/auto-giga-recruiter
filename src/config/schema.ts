import { z } from "zod";
import { defaultSelectors } from "../telegram/web/selectors.js";

const typingDelaySchema = z
  .object({
    minMs: z.number().int().min(0).default(3000),
    maxMs: z.number().int().min(0).default(12000),
    perCharMs: z.number().int().min(0).default(25),
  })
  .default({ minMs: 3000, maxMs: 12000, perCharMs: 25 });

const selectorsSchema = z
  .object(Object.fromEntries(Object.keys(defaultSelectors).map((k) => [k, z.string().min(1).optional()])))
  .default({});

export const configSchema = z.object({
  telegram: z
    .object({
      /** web — через Telegram Web в браузере (не нужны api_id/api_hash); mtproto — через GramJS */
      driver: z.enum(["web", "mtproto"]).default("web"),
      web: z
        .object({
          url: z.string().url().default("https://web.telegram.org/k/"),
          /** false — показать окно браузера (для отладки; в WSL нужен WSLg) */
          headless: z.boolean().default(true),
          pollMs: z.number().int().min(200).default(700),
          /** Переопределение CSS-селекторов, если Telegram поменял вёрстку */
          selectors: selectorsSchema,
        })
        .default({ url: "https://web.telegram.org/k/", headless: true, pollMs: 700, selectors: {} }),
    })
    .default({
      driver: "web",
      web: { url: "https://web.telegram.org/k/", headless: true, pollMs: 700, selectors: {} },
    }),

  bot: z
    .object({
      /** Username бота без @ */
      username: z.string().min(1).default("GigaRecruiterBot").transform((s) => s.trim().replace(/^@/, "")),
      /** Команда, по которой бот присылает список вакансий (/start этот бот не поддерживает) */
      vacancyCommand: z.string().default("/change_vacancy"),
    })
    .default({ username: "GigaRecruiterBot", vacancyCommand: "/change_vacancy" }),

  answers: z
    .object({
      maxChars: z.number().int().positive().default(800),
      minChars: z.number().int().min(0).default(0),
      language: z.string().default("ru"),
      tone: z.enum(["professional", "friendly", "concise"]).default("professional"),
      /** strict — только факты из резюме; flexible — можно разумно обобщать */
      honesty: z.enum(["strict", "flexible"]).default("strict"),
      /** Дополнительные инструкции для ИИ (зарплатные ожидания, формат работы и т.п.) */
      extraInstructions: z.string().default(""),
    })
    .default({
      maxChars: 800,
      minChars: 0,
      language: "ru",
      tone: "professional",
      honesty: "strict",
      extraInstructions: "",
    }),

  llm: z
    .object({
      /**
       * auto — API, если задан ANTHROPIC_API_KEY, иначе Claude Code CLI;
       * api — Anthropic API (ключ, оплата по токенам);
       * claude-code — локальный `claude -p` с твоей подпиской Claude (Pro/Max), ключ не нужен
       */
      provider: z.enum(["auto", "api", "claude-code"]).default("auto"),
      model: z.string().default("claude-opus-5"),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
      maxTokens: z.number().int().positive().default(8000),
      /** Серверный fallback на другую модель при refusal */
      fallbacks: z.boolean().default(true),
    })
    .default({ provider: "auto", model: "claude-opus-5", effort: "medium", maxTokens: 8000, fallbacks: true }),

  behavior: z
    .object({
      mode: z.enum(["auto", "confirm"]).default("auto"),
      typingDelay: typingDelaySchema,
      /** Сколько ждать тишины от бота, прежде чем отвечать */
      botIdleMs: z.number().int().min(200).default(2500),
      /** Сколько максимум ждать ответа бота, прежде чем спросить ИИ, что делать */
      botResponseTimeoutSec: z.number().int().positive().default(180),
      maxTurns: z.number().int().positive().default(60),
      /** 0 = нет лимита. Иначе задержки набора сжимаются, чтобы уложиться */
      questionTimeoutSec: z.number().int().min(0).default(0),
    })
    .default({
      mode: "auto",
      typingDelay: { minMs: 3000, maxMs: 12000, perCharMs: 25 },
      botIdleMs: 2500,
      botResponseTimeoutSec: 180,
      maxTurns: 60,
      questionTimeoutSec: 0,
    }),

  resumes: z
    .object({
      dir: z.string().default("./resumes"),
      default: z.string().optional(),
      perVacancy: z
        .array(z.object({ match: z.string(), resume: z.string() }))
        .default([]),
    })
    .default({ dir: "./resumes", perVacancy: [] }),

  logging: z
    .object({
      saveTranscripts: z.boolean().default(true),
      dir: z.string().default("./data"),
    })
    .default({ saveTranscripts: true, dir: "./data" }),
});

export type AppConfig = z.infer<typeof configSchema>;

export const envSchema = z.object({
  // Нужны только для telegram.driver = mtproto
  TG_API_ID: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().positive().optional()),
  TG_API_HASH: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(10).optional()),
  ANTHROPIC_API_KEY: z.string().optional(),
  SESSION_PASSPHRASE: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
});

export type AppEnv = z.infer<typeof envSchema>;
