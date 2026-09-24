export type ButtonKind = "inline" | "reply" | "url" | "other";

export interface BotButton {
  /** Сквозной индекс (слева направо, сверху вниз) — то, что видит ИИ */
  index: number;
  row: number;
  col: number;
  text: string;
  kind: ButtonKind;
  /** callback data (только для recon, только mtproto) */
  data?: string;
  url?: string;
}

export interface BotMessage {
  id: number;
  /** unix-время в секундах (0, если неизвестно) */
  date: number;
  text: string;
  /** Описание медиа, если есть: "voice", "photo", "document" ... */
  media?: string;
  buttons: BotButton[];
  edited: boolean;
  /** true — сообщение отправлено мной */
  out: boolean;
  /** Сырые технические детали для recon */
  meta?: Record<string, unknown>;
}

export interface WaitOptions {
  idleMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Общий интерфейс чата с ботом — реализуется MTProto-клиентом и браузерным драйвером. */
export interface BotChatLike {
  readonly title: string;
  waitForBotTurn(opts: WaitOptions): Promise<BotMessage[]>;
  drain(): BotMessage[];
  currentButtons(): BotButton[];
  click(index: number): Promise<{ label: string; alert?: string }>;
  sendText(text: string, typingMs?: number, signal?: AbortSignal): Promise<void>;
  /** Нажать «Start» (если бот ещё не запущен) или отправить команду */
  start(command: string): Promise<void>;
  history(limit?: number): Promise<BotMessage[]>;
  /** HTML-дамп чата для отладки селекторов (только web) */
  debugDump?(): Promise<string>;
  close(): Promise<void> | void;
}
