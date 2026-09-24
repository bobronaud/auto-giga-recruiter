import type { AppConfig, AppEnv } from "../config/schema.js";
import { connect, describeMe } from "./client.js";
import { MtprotoBotChat } from "./mtproto-chat.js";
import { SessionStore } from "./session-store.js";
import type { BotChatLike } from "./types.js";
import { profilePath, TelegramWeb } from "./web/browser.js";
import { defaultSelectors, type Selectors } from "./web/selectors.js";
import { WebBotChat } from "./web/web-chat.js";

export interface ChatSession {
  chat: BotChatLike;
  /** Кто залогинен (если удалось узнать) */
  me?: string;
  close(): Promise<void>;
}

export function webOptions(cfg: AppConfig, headless?: boolean) {
  const overrides = Object.fromEntries(Object.entries(cfg.telegram.web.selectors).filter(([, v]) => v)) as Partial<Selectors>;
  return {
    url: cfg.telegram.web.url,
    headless: headless ?? cfg.telegram.web.headless,
    profileDir: profilePath(cfg.logging.dir),
    selectors: { ...defaultSelectors, ...overrides } as Selectors,
  };
}

export function sessionStore(cfg: AppConfig, env: AppEnv): SessionStore {
  return new SessionStore(cfg.logging.dir, env.SESSION_PASSPHRASE);
}

/** Подключается к Telegram выбранным драйвером и открывает чат с ботом. */
export async function openBotChat(cfg: AppConfig, env: AppEnv, opts: { headless?: boolean } = {}): Promise<ChatSession> {
  if (cfg.telegram.driver === "mtproto") {
    const client = await connect(env, sessionStore(cfg, env));
    try {
      const me = await describeMe(client);
      const chat = await MtprotoBotChat.open(client, cfg.bot.username);
      return {
        chat,
        me,
        close: async () => {
          chat.close();
          await client.destroy().catch(() => undefined);
        },
      };
    } catch (err) {
      await client.destroy().catch(() => undefined);
      throw err;
    }
  }

  const web = await TelegramWeb.launch(webOptions(cfg, opts.headless));
  try {
    if (!(await web.isLoggedIn())) throw new Error("Вход в Telegram Web не выполнен. Сначала: npm run login");
    const chat = await WebBotChat.open(web, cfg.bot.username, cfg.telegram.web.pollMs);
    return {
      chat,
      close: async () => {
        chat.close();
        await web.close();
      },
    };
  } catch (err) {
    await web.close();
    throw err;
  }
}
