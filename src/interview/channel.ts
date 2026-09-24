import type { BotButton, BotMessage } from "../telegram/types.js";
import { askText } from "../ui/ask.js";

/** Абстракция чата с интервьюером: реальный Telegram-бот или симуляция в терминале (--dry-run). */
export interface InterviewChannel {
  readonly title: string;
  waitForBotTurn(opts: { idleMs: number; timeoutMs: number; signal?: AbortSignal }): Promise<BotMessage[]>;
  currentButtons(): BotButton[];
  click(index: number): Promise<{ label: string; alert?: string }>;
  sendText(text: string, typingMs?: number, signal?: AbortSignal): Promise<void>;
}

/**
 * Режим --dry-run: интервьюера играешь ты. Ничего не уходит в Telegram.
 * Формат ввода: «текст вопроса || Кнопка 1 | Кнопка 2» — после «||» можно перечислить кнопки.
 * Пустая строка завершает симуляцию.
 */
export class SimulatedChannel implements InterviewChannel {
  readonly title = "Интервьюер (симуляция)";
  private nextId = 1;
  private buttons: BotButton[] = [];

  async waitForBotTurn(): Promise<BotMessage[]> {
    const input = await askText("Сообщение интервьюера", {
      placeholder: "Расскажите о себе || Да | Нет   (пусто — завершить)",
    });
    if (!input) return [];
    const [text = "", btns] = input.split("||");
    this.buttons = (btns ?? "")
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((t, i) => ({ index: i, row: i, col: 0, text: t, kind: "inline" as const }));
    return [
      {
        id: this.nextId++,
        date: Math.floor(Date.now() / 1000),
        text: text.trim(),
        buttons: this.buttons,
        edited: false,
        out: false,
      },
    ];
  }

  currentButtons(): BotButton[] {
    return this.buttons;
  }

  async click(index: number) {
    const b = this.buttons.find((x) => x.index === index);
    if (!b) throw new Error(`Кнопки с индексом ${index} нет`);
    this.buttons = [];
    return { label: b.text };
  }

  async sendText(): Promise<void> {
    this.buttons = [];
  }
}
