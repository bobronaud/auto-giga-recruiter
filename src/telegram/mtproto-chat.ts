import { Api, TelegramClient, errors } from "telegram";
import { EditedMessage, type EditedMessageEvent } from "telegram/events/EditedMessage.js";
import { NewMessage, type NewMessageEvent } from "telegram/events/NewMessage.js";
import { Raw } from "telegram/events/Raw.js";
import { BaseBotChat, sleep } from "./base-chat.js";
import type { BotButton, BotChatLike, BotMessage, ButtonKind } from "./types.js";

function describeMedia(msg: Api.Message): string | undefined {
  if (!msg.media) return undefined;
  if (msg.voice) return "voice";
  if (msg.photo) return "photo";
  if (msg.video) return "video";
  if (msg.document) return `document:${msg.document.mimeType}`;
  return msg.media.className;
}

function extractButtons(msg: Api.Message): BotButton[] {
  const rows = msg.buttons;
  if (!rows) return [];
  const kindOf = (b: unknown): ButtonKind => {
    if (b instanceof Api.KeyboardButtonCallback) return "inline";
    if (b instanceof Api.KeyboardButtonUrl) return "url";
    if (b instanceof Api.KeyboardButton) return "reply";
    return "other";
  };
  const out: BotButton[] = [];
  rows.forEach((row, r) =>
    row.forEach((btn, c) => {
      out.push({
        index: out.length,
        row: r,
        col: c,
        text: btn.text,
        kind: kindOf(btn.button),
        data: btn.data ? btn.data.toString("utf8") : undefined,
        url: btn.url,
      });
    }),
  );
  return out;
}

function toBotMessage(msg: Api.Message, edited: boolean): BotMessage {
  return {
    id: msg.id,
    date: msg.date,
    text: msg.message ?? "",
    media: describeMedia(msg),
    buttons: extractButtons(msg),
    edited,
    out: Boolean(msg.out),
    meta: {
      markup: msg.replyMarkup?.className,
      entities: msg.entities?.map((e) => e.className),
    },
  };
}

/** Повтор запроса при FloodWait: Telegram просит подождать N секунд. */
export async function withFloodWait<T>(fn: () => Promise<T>, onWait?: (sec: number) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof errors.FloodWaitError && attempt < 3) {
        onWait?.(err.seconds);
        await sleep((err.seconds + 1) * 1000);
        continue;
      }
      throw err;
    }
  }
}

/** Чат с ботом через MTProto (GramJS). Требует TG_API_ID / TG_API_HASH. */
export class MtprotoBotChat extends BaseBotChat implements BotChatLike {
  private raw = new Map<number, Api.Message>();
  private handlers: Array<[(e: any) => void, any]> = [];
  private botUserId: string;

  private constructor(
    readonly client: TelegramClient,
    readonly entity: Api.User,
  ) {
    super();
    this.botUserId = entity.id.toString();
  }

  static async open(client: TelegramClient, username: string): Promise<MtprotoBotChat> {
    const entity = await client.getEntity(username.replace(/^@/, ""));
    if (!(entity instanceof Api.User)) throw new Error(`@${username} — это не пользователь/бот`);
    if (!entity.bot) throw new Error(`@${username} — не бот. Проверь bot.username в config.yaml`);
    const chat = new MtprotoBotChat(client, entity);
    chat.subscribe();
    return chat;
  }

  get title(): string {
    return [this.entity.firstName, this.entity.lastName].filter(Boolean).join(" ") || this.entity.username || "bot";
  }

  private onMessage(msg: Api.Message, edited: boolean) {
    if (msg.out) return;
    this.raw.set(msg.id, msg);
    this.ingest(toBotMessage(msg, edited));
  }

  private subscribe() {
    const onNew = (e: NewMessageEvent) => this.onMessage(e.message, false);
    const onEdit = (e: EditedMessageEvent) => this.onMessage(e.message, true);
    // «Бот печатает…» продлевает ожидание, чтобы не отвечать посреди серии сообщений
    const onRaw = (u: Api.TypeUpdate) => {
      if (u instanceof Api.UpdateUserTyping && u.userId.toString() === this.botUserId) this.touch();
    };
    const newEv = new NewMessage({ chats: [this.entity], incoming: true });
    const editEv = new EditedMessage({ chats: [this.entity] });
    const rawEv = new Raw({ types: [Api.UpdateUserTyping] });
    this.client.addEventHandler(onNew, newEv);
    this.client.addEventHandler(onEdit, editEv);
    this.client.addEventHandler(onRaw as (e: any) => void, rawEv);
    this.handlers.push([onNew, newEv], [onEdit, editEv], [onRaw, rawEv]);
  }

  close() {
    for (const [fn, ev] of this.handlers) this.client.removeEventHandler(fn, ev);
    this.handlers = [];
  }

  async history(limit = 10): Promise<BotMessage[]> {
    const msgs = (await this.client.getMessages(this.entity, { limit }))
      .filter((m): m is Api.Message => m instanceof Api.Message)
      .reverse();
    msgs.forEach((m) => this.raw.set(m.id, m));
    const out = msgs.map((m) => toBotMessage(m, false));
    this.rememberButtons(out);
    return out;
  }

  async start(command: string): Promise<void> {
    await this.sendText(command);
  }

  async click(index: number): Promise<{ label: string; alert?: string }> {
    const { msg, btn } = this.findButton(index);
    const raw = this.raw.get(msg.id);
    if (!raw) throw new Error("Сообщение с кнопками не найдено");
    const res = await withFloodWait(() => raw.click({ i: index }));
    // Ответ на callback может содержать всплывающее уведомление
    const alert = res instanceof Api.messages.BotCallbackAnswer ? res.message : undefined;
    if (btn.kind === "inline") this.touch();
    return { label: btn.text, alert };
  }

  /** Показывает «печатает…» заданное время, затем отправляет текст. */
  async sendText(text: string, typingMs = 0, signal?: AbortSignal): Promise<void> {
    const until = Date.now() + typingMs;
    while (Date.now() < until && !signal?.aborted) {
      await this.client
        .invoke(new Api.messages.SetTyping({ peer: this.entity, action: new Api.SendMessageTypingAction() }))
        .catch(() => undefined);
      await sleep(Math.min(4500, Math.max(0, until - Date.now())));
    }
    if (signal?.aborted) return;
    await withFloodWait(() => this.client.sendMessage(this.entity, { message: text }));
  }
}
