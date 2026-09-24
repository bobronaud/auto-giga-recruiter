import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { AppConfig } from "../config/schema.js";
import { actionSchema, type InterviewAction } from "./action.js";
import { RefusalError, type Brain, type Usage } from "./brain.js";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;

/**
 * Разговор с Claude для одного интервью. История только дописывается (append-only),
 * поэтому префикс «system + ранние ходы» кэшируется между запросами.
 */
export class InterviewBrain implements Brain {
  readonly provider = "api" as const;
  private client: Anthropic;
  private messages: MessageParam[] = [];
  readonly usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };

  constructor(
    apiKey: string,
    private readonly llm: AppConfig["llm"],
    private readonly system: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 4 });
  }

  /** Добавляет ход бота (роль user) и спрашивает, что делать. */
  async decide(botTurn: string): Promise<InterviewAction> {
    this.pushUser(botTurn);
    return this.request();
  }

  /** Просьба переделать последний ответ (слишком длинный / подсказка пользователя). */
  async revise(instruction: string): Promise<InterviewAction> {
    this.pushUser(`(служебно: ${instruction})`);
    return this.request();
  }

  private pushUser(text: string) {
    const last = this.messages.at(-1);
    // Два user-хода подряд склеиваем (например, после ошибки запроса)
    if (last?.role === "user" && Array.isArray(last.content)) {
      last.content.push({ type: "text", text });
    } else {
      this.messages.push({ role: "user", content: [{ type: "text", text }] });
    }
  }

  private async request(): Promise<InterviewAction> {
    const params = {
      model: this.llm.model,
      max_tokens: this.llm.maxTokens,
      thinking: { type: "adaptive" as const },
      output_config: { effort: this.llm.effort, format: betaZodOutputFormat(actionSchema) },
      system: [{ type: "text" as const, text: this.system, cache_control: { type: "ephemeral" as const } }],
      // Кэшируем и растущую историю: breakpoint на последнем блоке
      cache_control: { type: "ephemeral" as const },
      messages: this.messages,
      ...(this.llm.fallbacks
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
    };
    const res = await this.client.beta.messages.parse(params);

    this.usage.requests++;
    this.usage.input += res.usage.input_tokens;
    this.usage.output += res.usage.output_tokens;
    this.usage.cacheRead += res.usage.cache_read_input_tokens ?? 0;
    this.usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0;

    if (res.stop_reason === "refusal") {
      throw new RefusalError("Модель отказалась отвечать на этот шаг");
    }
    this.messages.push({ role: "assistant", content: toParams(res.content) });

    const parsed = res.parsed_output;
    if (!parsed) {
      if (res.stop_reason === "max_tokens") {
        throw new Error("Ответ модели обрезан по max_tokens: увеличь llm.maxTokens в config.yaml");
      }
      throw new Error("Модель вернула ответ не по схеме");
    }
    return parsed;
  }
}

/** Возвращаем в историю только те блоки, которые API принимает обратно, без служебных полей. */
function toParams(blocks: ContentBlock[]): ContentBlockParam[] {
  const out: ContentBlockParam[] = [];
  for (const b of blocks) {
    if (b.type === "text") out.push({ type: "text", text: b.text });
    else if (b.type === "thinking") out.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
    else if (b.type === "redacted_thinking") out.push({ type: "redacted_thinking", data: b.data });
  }
  return out;
}

export async function countTokens(apiKey: string, model: string, text: string): Promise<number> {
  const client = new Anthropic({ apiKey });
  const res = await client.messages.countTokens({ model, messages: [{ role: "user", content: text }] });
  return res.input_tokens;
}
