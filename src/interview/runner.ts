import * as p from "@clack/prompts";
import Anthropic from "@anthropic-ai/sdk";
import pc from "picocolors";
import type { AppConfig } from "../config/schema.js";
import { fitToLimit, type InterviewAction } from "../llm/action.js";
import { foreignChars, humanize, stripForeign } from "../llm/humanize.js";
import { RefusalError, TransientBrainError, type Brain } from "../llm/brain.js";
import { formatBotTurn, vacancyNote } from "../llm/prompts.js";
import type { Transcript } from "../storage/transcripts.js";
import type { BotMessage } from "../telegram/types.js";
import { askSelect, askText } from "../ui/ask.js";
import { actionLine, botBubble, charMeter, formatDuration, meBubble } from "../ui/render.js";
import { redactError } from "../util/redact.js";
import type { InterviewChannel } from "./channel.js";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export interface RunOptions {
  channel: InterviewChannel;
  cfg: AppConfig;
  brain: Brain;
  vacancy?: string;
  mode: "auto" | "confirm";
  /** Сообщения, уже полученные на этапе навигации (после выбора вакансии) */
  initialMessages?: BotMessage[];
  initialNotes?: string[];
  transcript: Transcript;
  signal: AbortSignal;
  /** Не имитировать набор текста (для --dry-run) */
  noTyping?: boolean;
}

export interface RunResult {
  provider: Brain["provider"];
  reason: string;
  replies: number;
  clicks: number;
  durationMs: number;
  usage: Brain["usage"];
}

/** Время «набора» ответа: пропорционально длине, с разбросом, с учётом таймера на вопрос. */
export function typingDelayMs(len: number, cfg: AppConfig["behavior"], elapsedMs: number): number {
  const { minMs, maxMs, perCharMs } = cfg.typingDelay;
  let ms = Math.min(maxMs, Math.max(minMs, len * perCharMs));
  ms *= 0.85 + Math.random() * 0.3;
  if (cfg.questionTimeoutSec > 0) {
    // Оставляем минимум половину лимита времени в запасе
    ms = Math.min(ms, Math.max(0, cfg.questionTimeoutSec * 1000 * 0.5 - elapsedMs));
  }
  return Math.round(ms);
}

export async function runInterview(o: RunOptions): Promise<RunResult> {
  const { cfg, channel, transcript, signal } = o;
  const b = cfg.behavior;
  const started = Date.now();
  const brain = o.brain;

  let notes: string[] = [...(o.initialNotes ?? [])];
  const vn = vacancyNote(o.vacancy);
  if (vn) notes.unshift(vn);

  let incoming: BotMessage[] = o.initialMessages ?? [];
  let replies = 0;
  let clicks = 0;
  let silentStreak = 0;
  let reason = `достигнут лимит ходов (${b.maxTurns})`;

  turns: for (let turn = 0; turn < b.maxTurns; turn++) {
    if (signal.aborted) {
      reason = "прервано пользователем (Ctrl+C)";
      break;
    }

    // 1. Ждём, пока бот договорит
    if (!incoming.length) {
      const s = p.spinner();
      s.start("Ждём сообщение от бота…");
      incoming = await channel.waitForBotTurn({ idleMs: b.botIdleMs, timeoutMs: b.botResponseTimeoutSec * 1000, signal });
      s.stop(incoming.length ? `Бот написал: ${incoming.length} сообщ.` : pc.yellow("Бот молчит"));
      if (signal.aborted) continue;
      if (!incoming.length) {
        silentStreak++;
        if (silentStreak >= 2) {
          reason = `бот не отвечает ${b.botResponseTimeoutSec * silentStreak} с`;
          break;
        }
        notes.push(`бот ничего не пишет уже ${b.botResponseTimeoutSec} с`);
      }
    }
    if (incoming.length) silentStreak = 0;
    const questionAt = Date.now();

    for (const m of incoming) {
      botBubble(m, channel.title);
      transcript.add({ role: "bot", text: m.text, buttons: m.buttons.map((x) => x.text) });
    }

    // 2. Спрашиваем ИИ
    const buttons = channel.currentButtons();
    const prompt = formatBotTurn(incoming, buttons, notes);
    incoming = [];
    notes = [];

    let action = await think(() => brain.decide(prompt), signal);
    if (!action) {
      reason = signal.aborted ? "прервано пользователем (Ctrl+C)" : "не удалось получить ответ от Claude";
      break;
    }

    // 3. Валидация и доработка ответа
    for (let attempt = 0; attempt < 2; attempt++) {
      if (action.action === "reply") action = { ...action, text: humanize(action.text) };
      const foreign = action.action === "reply" ? foreignChars(action.text) : [];
      let fix: string | undefined;
      if (foreign.length) {
        fix = `в ответе есть символы, которых нет на клавиатуре: ${foreign.join(" ")}. Перепиши эти места обычными русскими или английскими словами.`;
      } else if (action.action === "click" && !buttons.some((x) => x.index === action!.button_index && x.kind !== "url")) {
        fix = `кнопки с индексом ${action.button_index} нет. Выбери индекс из списка или другое действие.`;
      } else if (action.action === "reply" && !action.text.trim()) {
        fix = "для action=reply поле text не может быть пустым.";
      } else if (action.action === "reply" && action.text.length > cfg.answers.maxChars) {
        fix = `ответ ${action.text.length} символов, лимит ${cfg.answers.maxChars}. Сократи, сохранив суть.`;
      } else if (action.action === "reply" && action.text.length < cfg.answers.minChars) {
        fix = `ответ ${action.text.length} символов, минимум ${cfg.answers.minChars}. Раскрой подробнее.`;
      }
      if (!fix) break;
      actionLine("↻", `переделываем: ${fix}`);
      const next = await think(() => brain.revise(fix!), signal);
      if (!next) break;
      action = next;
    }
    if (action.action === "reply") action = { ...action, text: stripForeign(humanize(action.text)) };

    // 4. Режим подтверждения
    const proposedText = action.text.trim();
    if (o.mode === "confirm") {
      const decided = await confirmAction(action, brain, cfg, signal);
      if (decided === "quit") {
        reason = "остановлено пользователем";
        break;
      }
      action = decided;
    }

    // 5. Исполнение
    transcript.add({ role: "me", text: action.text, action: action.action, reason: action.reason });
    switch (action.action) {
      case "reply": {
        let text = action.text.trim();
        if (text.length > cfg.answers.maxChars) text = fitToLimit(text, cfg.answers.maxChars);
        if (text !== proposedText) notes.push(`фактически отправлен другой текст: «${text}»`);
        const typing = o.noTyping ? 0 : typingDelayMs(text.length, b, Date.now() - questionAt);
        const s = p.spinner();
        s.start(`Печатаю… (${formatDuration(typing)})`);
        try {
          await channel.sendText(text, typing, signal);
        } finally {
          s.stop(pc.dim("Отправлено"));
        }
        if (signal.aborted) continue turns;
        meBubble(text, charMeter(text.length, cfg.answers.maxChars));
        replies++;
        break;
      }
      case "click": {
        try {
          const res = await channel.click(action.button_index);
          actionLine("👆", `нажал «${res.label}»`);
          clicks++;
          if (res.alert) {
            actionLine("💬", res.alert);
            notes.push(`после нажатия бот показал уведомление: «${res.alert}»`);
          }
        } catch (err) {
          actionLine("⚠", redactError(err));
          notes.push(`не удалось нажать кнопку: ${redactError(err)}`);
        }
        break;
      }
      case "wait":
        actionLine("⏳", `жду (${action.reason})`);
        break;
      case "finish":
        reason = `интервью завершено: ${action.reason}`;
        break turns;
    }
  }

  return { provider: brain.provider, reason, replies, clicks, durationMs: Date.now() - started, usage: brain.usage };
}

/** Запрос к Claude со спиннером и повторами при сетевых / серверных ошибках. */
async function think(fn: () => Promise<InterviewAction>, signal: AbortSignal): Promise<InterviewAction | undefined> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal.aborted) return undefined;
    const s = p.spinner();
    s.start("Claude думает…");
    try {
      const a = await fn();
      s.stop(pc.dim(`Решение: ${a.action} · ${a.reason}`));
      return a;
    } catch (err) {
      const retryable =
        err instanceof RefusalError ||
        err instanceof TransientBrainError ||
        err instanceof Anthropic.RateLimitError ||
        err instanceof Anthropic.InternalServerError ||
        err instanceof Anthropic.APIConnectionError;
      s.error(pc.red(`Ошибка Claude: ${redactError(err)}`));
      if (!retryable || attempt === 3) return undefined;
      const wait = 15_000 * attempt;
      actionLine("⏱", `повтор через ${wait / 1000} с`);
      await sleep(wait, signal);
    }
  }
  return undefined;
}

async function confirmAction(
  action: InterviewAction,
  brain: Brain,
  cfg: AppConfig,
  signal: AbortSignal,
): Promise<InterviewAction | "quit"> {
  for (;;) {
    const preview =
      action.action === "reply"
        ? `${action.text}\n\n${charMeter(action.text.length, cfg.answers.maxChars)}`
        : `${action.action}${action.action === "click" ? ` #${action.button_index}` : ""} — ${action.reason}`;
    p.note(preview, "Предлагаемое действие");
    const choice = await askSelect("Что делаем?", [
      { value: "ok", label: "Отправить" },
      { value: "edit", label: "Отредактировать текст" },
      { value: "regen", label: "Перегенерировать с подсказкой" },
      { value: "wait", label: "Ничего не делать (wait)" },
      { value: "quit", label: "Остановить интервью" },
    ]);
    if (choice === "ok") return action;
    if (choice === "quit") return "quit";
    if (choice === "wait") return { action: "wait", text: "", button_index: -1, reason: "пропущено пользователем" };
    if (choice === "edit") {
      const text = await askText("Текст ответа", { initialValue: action.text, required: true });
      return { action: "reply", text, button_index: -1, reason: "отредактировано пользователем" };
    }
    const hint = await askText("Подсказка для ИИ", { placeholder: "короче, упомяни проект X…", required: true });
    const next = await think(() => brain.revise(`кандидат просит переделать ответ: ${hint}`), signal);
    if (next) action = next.action === "reply" ? { ...next, text: stripForeign(humanize(next.text)) } : next;
  }
}
