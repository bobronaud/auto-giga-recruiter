import type { BotButton, BotMessage, WaitOptions } from "./types.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Общая логика чата с ботом: копит входящие сообщения и правки,
 * ждёт, пока бот «договорит», и помнит актуальные кнопки.
 */
export abstract class BaseBotChat {
  private pending = new Map<number, BotMessage>();
  private lastActivity = 0;
  protected lastButtonsMsg: BotMessage | undefined;
  /** true сразу после drain(): следующее сообщение открывает новую «порцию» */
  private freshBatch = true;
  private waiters: Array<() => void> = [];

  /** Любая активность бота (сообщение, правка, «печатает…») продлевает ожидание. */
  protected touch() {
    this.lastActivity = Date.now();
    const w = this.waiters;
    this.waiters = [];
    w.forEach((fn) => fn());
  }

  protected ingest(bm: BotMessage) {
    if (bm.out) return;
    this.pending.set(bm.id, bm);
    if (bm.buttons.length) {
      this.lastButtonsMsg = bm;
    } else if (this.lastButtonsMsg?.id === bm.id) {
      // Бот убрал клавиатуру правкой сообщения
      this.lastButtonsMsg = undefined;
    } else if (!bm.edited && this.freshBatch && this.lastButtonsMsg?.buttons.every((b) => b.kind !== "reply")) {
      // Новая порция сообщений без кнопок: старые inline-кнопки (например, список вакансий) уже неактуальны.
      // Reply-клавиатура остаётся, пока бот её не заменит.
      this.lastButtonsMsg = undefined;
    }
    this.freshBatch = false;
    this.touch();
  }

  /** Запоминает кнопки из истории (при открытии чата), не добавляя сообщения в очередь. */
  protected rememberButtons(messages: BotMessage[]) {
    const last = [...messages].reverse().find((m) => !m.out);
    if (last?.buttons.length) this.lastButtonsMsg = last;
  }

  /**
   * Ждёт новых сообщений бота; возвращает их, когда бот замолчал на `idleMs`.
   * Если за `timeoutMs` ничего не пришло — возвращает пустой массив.
   */
  async waitForBotTurn(opts: WaitOptions): Promise<BotMessage[]> {
    const deadline = Date.now() + opts.timeoutMs;
    while (this.pending.size === 0) {
      if (opts.signal?.aborted) return [];
      const left = deadline - Date.now();
      if (left <= 0) return [];
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 1000));
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    while (Date.now() - this.lastActivity < opts.idleMs) {
      if (opts.signal?.aborted) break;
      await sleep(Math.max(50, opts.idleMs - (Date.now() - this.lastActivity)));
    }
    return this.drain();
  }

  drain(): BotMessage[] {
    const out = [...this.pending.values()].sort((a, b) => a.id - b.id);
    this.pending.clear();
    this.freshBatch = true;
    return out;
  }

  /** Кнопки, актуальные сейчас (из последнего сообщения бота с клавиатурой). */
  currentButtons(): BotButton[] {
    return this.lastButtonsMsg?.buttons ?? [];
  }

  protected findButton(index: number): { msg: BotMessage; btn: BotButton } {
    const buttons = this.currentButtons();
    const btn = buttons.find((b) => b.index === index);
    const msg = this.lastButtonsMsg;
    if (!btn || !msg) throw new Error(`Кнопки с индексом ${index} нет`);
    if (btn.kind === "url") throw new Error(`Кнопка «${btn.text}» — это ссылка, нажать её нельзя`);
    return { msg, btn };
  }
}
