import type { Page } from "playwright";
import { BaseBotChat, sleep } from "../base-chat.js";
import type { BotButton, BotChatLike, BotMessage } from "../types.js";
import type { TelegramWeb } from "./browser.js";
import { call, DEBUG_DUMP_JS, SNAPSHOT_JS } from "./page-scripts.js";
import type { Selectors } from "./selectors.js";

/** Снимок одного сообщения, извлечённый со страницы. */
interface RawBubble {
  mid: number;
  out: boolean;
  text: string;
  rows: Array<Array<{ text: string; url?: string }>>;
  edited: boolean;
  media?: string;
  ts: number;
}

interface Snapshot {
  ok: boolean;
  bubbles: RawBubble[];
  keyboard: Array<Array<{ text: string }>>;
  typing: boolean;
  startVisible: boolean;
  inputVisible: boolean;
  title: string;
}

function toButtons(rows: RawBubble["rows"], kind: "inline" | "reply"): BotButton[] {
  const out: BotButton[] = [];
  rows.forEach((row, r) =>
    row.forEach((b, c) => out.push({ index: out.length, row: r, col: c, text: b.text, kind: b.url ? "url" : kind, url: b.url })),
  );
  return out;
}

function toMessage(b: RawBubble, edited: boolean): BotMessage {
  return {
    id: b.mid,
    date: b.ts,
    text: b.text,
    media: b.media,
    buttons: toButtons(b.rows, "inline"),
    edited: edited || b.edited,
    out: b.out,
    meta: { mid: b.mid, rows: b.rows.length },
  };
}

const signature = (b: RawBubble) => JSON.stringify([b.text, b.rows, b.edited, b.media]);

/** Чат с ботом через Telegram Web в браузере (Playwright). Не требует api_id / api_hash. */
export class WebBotChat extends BaseBotChat implements BotChatLike {
  private seen = new Map<number, string>();
  private last: Snapshot | undefined;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private readonly page: Page;
  private readonly sel: Selectors;
  private username: string;

  private constructor(
    private readonly web: TelegramWeb,
    username: string,
    private readonly pollMs: number,
  ) {
    super();
    this.page = web.page;
    this.sel = web.opts.selectors;
    this.username = username.replace(/^@/, "");
  }

  static async open(web: TelegramWeb, username: string, pollMs = 700): Promise<WebBotChat> {
    const chat = new WebBotChat(web, username, pollMs);
    await chat.navigate();
    return chat;
  }

  get title(): string {
    return this.last?.title || this.username;
  }

  /**
   * Открывает чат по ссылке вида https://web.telegram.org/k/#@username и ждёт его загрузки.
   * Telegram Web читает #@username только при загрузке страницы, поэтому, если чат
   * не открылся, страница перезагружается с этим адресом.
   */
  private async navigate() {
    const base = this.web.opts.url.replace(/#.*$/, "");
    await this.page.goto(`${base}#@${this.username}`, { waitUntil: "domcontentloaded" });
    let reloaded = false;
    const started = Date.now();
    const deadline = started + 40_000;
    while (Date.now() < deadline) {
      if (!reloaded && Date.now() - started > 4000) {
        reloaded = true;
        await this.page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      }
      const snap = await this.snapshot();
      if (snap?.ok && (snap.inputVisible || snap.startVisible)) {
        // Даём догрузиться истории
        await sleep(1500);
        const settled = (await this.snapshot()) ?? snap;
        this.last = settled;
        for (const b of settled.bubbles) this.seen.set(b.mid, signature(b));
        this.rememberButtons(settled.bubbles.map((b) => toMessage(b, false)));
        this.startPolling();
        return;
      }
      await sleep(500);
    }
    throw new Error(`Не удалось открыть чат @${this.username} в Telegram Web. Проверь bot.username в config.yaml`);
  }

  private async snapshot(): Promise<Snapshot | undefined> {
    return this.page.evaluate<Snapshot>(call(SNAPSHOT_JS, this.sel)).catch(() => undefined);
  }

  private startPolling() {
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const snap = await this.snapshot();
      if (!snap?.ok) return;
      this.last = snap;
      if (snap.typing) this.touch();
      for (const b of snap.bubbles) {
        const sig = signature(b);
        const prev = this.seen.get(b.mid);
        if (prev === sig) continue;
        this.seen.set(b.mid, sig);
        if (b.out) continue;
        this.ingest(toMessage(b, prev !== undefined));
      }
    } finally {
      this.polling = false;
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
  }

  async history(limit = 10): Promise<BotMessage[]> {
    const snap = (await this.snapshot()) ?? this.last;
    return (snap?.bubbles ?? []).slice(-limit).map((b) => toMessage(b, false));
  }

  /** Inline-кнопки последнего сообщения, а если их нет — reply-клавиатура под полем ввода. */
  currentButtons(): BotButton[] {
    const inline = super.currentButtons();
    if (inline.length) return inline;
    return toButtons(this.last?.keyboard ?? [], "reply");
  }

  async start(command: string): Promise<void> {
    const start = this.page
      .locator(this.sel.startButton)
      .filter({ hasText: new RegExp(this.sel.startButtonText, "i") })
      .first();
    if (await start.isVisible().catch(() => false)) {
      await start.click();
      return;
    }
    await this.sendText(command);
  }

  async click(index: number): Promise<{ label: string; alert?: string }> {
    const btn = this.currentButtons().find((b) => b.index === index);
    if (!btn) throw new Error(`Кнопки с индексом ${index} нет`);
    if (btn.kind === "url") throw new Error(`Кнопка «${btn.text}» — это ссылка, нажать её нельзя`);

    if (btn.kind === "reply") {
      // Нажатие reply-кнопки = отправка её текста
      await this.sendText(btn.text);
      return { label: btn.text };
    }

    const msg = this.lastButtonsMsg!;
    const button = this.page
      .locator(`${this.sel.bubblesInner} ${this.sel.bubble}[data-mid="${msg.id}"] ${this.sel.inlineMarkup} ${this.sel.markupRow}`)
      .nth(btn.row)
      .locator(this.sel.markupButton)
      .nth(btn.col);
    await button.scrollIntoViewIfNeeded();
    await button.click();
    this.touch();
    return { label: btn.text, alert: await this.readAlert() };
  }

  /** Ответ бота на нажатие кнопки может прийти всплывающим уведомлением или окном с «ОК». */
  private async readAlert(): Promise<string | undefined> {
    await sleep(900);
    const popup = this.page.locator(this.sel.popupText).first();
    if (await popup.isVisible().catch(() => false)) {
      const text = (await popup.innerText()).trim();
      await this.page.locator(this.sel.popupOk).first().click().catch(() => undefined);
      return text || undefined;
    }
    const toast = this.page.locator(this.sel.toast).last();
    if (await toast.isVisible().catch(() => false)) return (await toast.innerText()).trim() || undefined;
    return undefined;
  }

  /**
   * Печатает текст в поле ввода порциями в течение `typingMs`
   * (Telegram сам показывает боту «печатает…»), затем отправляет.
   */
  async sendText(text: string, typingMs = 0, signal?: AbortSignal): Promise<void> {
    const input = this.page.locator(this.sel.input).first();
    if (!(await input.isVisible().catch(() => false))) {
      throw new Error("Поле ввода недоступно (бот не запущен или чат заблокирован)");
    }
    await input.click();
    // Очищаем черновик
    await this.page.keyboard.press("Control+A");
    await this.page.keyboard.press("Delete");

    const steps = Math.max(1, Math.min(60, Math.ceil(typingMs / 400)));
    const chunk = Math.ceil(text.length / steps);
    for (let i = 0; i < text.length; i += chunk) {
      if (signal?.aborted) return;
      const lines = text.slice(i, i + chunk).split("\n");
      for (let j = 0; j < lines.length; j++) {
        if (lines[j]) await this.page.keyboard.insertText(lines[j]!);
        // Enter отправляет сообщение, поэтому перенос строки — через Shift+Enter
        if (j < lines.length - 1) await this.page.keyboard.press("Shift+Enter");
      }
      if (typingMs) await sleep(typingMs / steps);
    }
    if (signal?.aborted) return;

    const typed = ((await input.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    if (!typed) throw new Error("Не удалось ввести текст в поле сообщения");
    await this.page.keyboard.press("Enter");
    await sleep(300);
    // Если Enter перехватило меню подсказок команд — отправляем кнопкой
    if (((await input.innerText().catch(() => "")) ?? "").trim()) {
      await this.page.locator(this.sel.sendButton).first().click().catch(() => undefined);
    }
  }

  /** HTML последних сообщений и области ввода — чтобы поправить селекторы, если Telegram поменял вёрстку. */
  async debugDump(): Promise<string> {
    return this.page.evaluate<string>(call(DEBUG_DUMP_JS, this.sel));
  }
}
