import { TelegramClient } from "telegram";
import { LogLevel } from "telegram/extensions/Logger.js";
import { StringSession } from "telegram/sessions/index.js";
import type { AppEnv } from "../config/schema.js";
import { registerSecret } from "../util/redact.js";
import { SessionStore } from "./session-store.js";

export interface LoginPrompts {
  phone: () => Promise<string>;
  code: (viaApp: boolean) => Promise<string>;
  password: (hint?: string) => Promise<string>;
  onError: (err: Error) => void;
}

function createClient(env: AppEnv, session: string): TelegramClient {
  if (!env.TG_API_ID || !env.TG_API_HASH) throw new Error("TG_API_ID / TG_API_HASH не заданы в .env");
  registerSecret(env.TG_API_HASH);
  registerSecret(session);
  const client = new TelegramClient(new StringSession(session), env.TG_API_ID, env.TG_API_HASH, {
    connectionRetries: 5,
    deviceModel: "auto-giga-recruiter",
    appVersion: "0.1.0",
  });
  // GramJS по умолчанию очень болтлив и может печатать служебные данные
  client.setLogLevel(LogLevel.ERROR);
  return client;
}

/** Интерактивный вход. Телефон и 2FA-пароль нигде не сохраняются, сохраняется только сессия. */
export async function login(env: AppEnv, store: SessionStore, prompts: LoginPrompts): Promise<TelegramClient> {
  const client = createClient(env, "");
  await client.start({
    phoneNumber: async () => {
      const phone = await prompts.phone();
      registerSecret(phone);
      return phone;
    },
    phoneCode: async (viaApp) => prompts.code(Boolean(viaApp)),
    password: async (hint) => prompts.password(hint),
    onError: (err) => {
      prompts.onError(err);
    },
  });
  const saved = client.session.save() as unknown as string;
  registerSecret(saved);
  store.save(saved);
  return client;
}

/** Подключение по сохранённой сессии. */
export async function connect(env: AppEnv, store: SessionStore): Promise<TelegramClient> {
  const session = store.load();
  if (!session) {
    throw new Error("Нет сохранённой сессии. Сначала выполни: npm run login");
  }
  const client = createClient(env, session);
  await client.connect();
  if (!(await client.checkAuthorization())) {
    throw new Error("Сессия недействительна или отозвана. Выполни: npm run login");
  }
  return client;
}

export async function describeMe(client: TelegramClient): Promise<string> {
  const me = await client.getMe();
  const name = [me.firstName, me.lastName].filter(Boolean).join(" ");
  return me.username ? `${name} (@${me.username})` : name;
}
