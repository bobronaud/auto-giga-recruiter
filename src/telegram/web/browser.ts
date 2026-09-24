import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import jsQRModule from "jsqr";
import { PNG } from "pngjs";
import { chromium, type BrowserContext, type Page } from "playwright";
import QRCode from "qrcode";
import type { Selectors } from "./selectors.js";

// jsqr — CommonJS-модуль с default-экспортом
const jsQR = ((jsQRModule as unknown as { default?: unknown }).default ?? jsQRModule) as unknown as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;

export interface WebOptions {
  url: string;
  headless: boolean;
  profileDir: string;
  selectors: Selectors;
}

export function profilePath(dataDir: string): string {
  return resolve(join(dataDir, "browser-profile"));
}

export function hasProfile(dataDir: string): boolean {
  return existsSync(profilePath(dataDir));
}

export function removeProfile(dataDir: string): void {
  rmSync(profilePath(dataDir), { recursive: true, force: true });
}

/**
 * Обычный User-Agent вместо «HeadlessChrome»: так headless-браузер выглядит
 * как обычный Chrome на Linux.
 */
async function normalUserAgent(): Promise<string> {
  const b = await chromium.launch();
  const version = b.version();
  await b.close();
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

export class TelegramWeb {
  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    readonly opts: WebOptions,
  ) {}

  /**
   * Запускает Chromium с постоянным профилем в data/browser-profile.
   * В профиле хранится авторизация Telegram Web — это секрет, как и сессия.
   */
  static async launch(opts: WebOptions): Promise<TelegramWeb> {
    mkdirSync(opts.profileDir, { recursive: true, mode: 0o700 });
    chmodSync(opts.profileDir, 0o700);
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(opts.profileDir, {
        headless: opts.headless,
        userAgent: await normalUserAgent(),
        viewport: { width: 1280, height: 900 },
        locale: "ru-RU",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Executable doesn't exist|playwright install/i.test(msg)) {
        throw new Error("Chromium не установлен. Выполни: npx playwright install chromium");
      }
      if (/ProcessSingleton|profile.*in use|SingletonLock/i.test(msg)) {
        throw new Error("Профиль браузера занят: утилита уже запущена в другом терминале?");
      }
      throw err;
    }
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return new TelegramWeb(context, page, opts);
  }

  /** Какой экран сейчас открыт: вход по QR, ввод пароля 2FA или основной интерфейс. */
  async detectState(timeoutMs = 45_000): Promise<"qr" | "password" | "ready"> {
    const s = this.opts.selectors;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.page.locator(s.loggedIn).first().isVisible().catch(() => false)) return "ready";
      if (await this.page.locator(s.passwordInput).first().isVisible().catch(() => false)) return "password";
      if (await this.page.locator(s.qrCanvas).first().isVisible().catch(() => false)) return "qr";
      await this.page.waitForTimeout(500);
    }
    throw new Error("Не удалось распознать страницу Telegram Web (нет ни QR-кода, ни списка чатов)");
  }

  async isLoggedIn(): Promise<boolean> {
    return (await this.detectState()) === "ready";
  }

  /** Считывает QR-код со страницы и возвращает зашитую в него ссылку tg://login?token=… */
  async readQr(): Promise<string | undefined> {
    const canvas = this.page.locator(this.opts.selectors.qrCanvas).first();
    const box = await canvas.boundingBox().catch(() => null);
    if (!box) return undefined;
    const pad = 16;
    const buf = await this.page.screenshot({
      clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 },
    });
    const png = PNG.sync.read(buf);
    return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
  }

  /**
   * Вход по QR-коду прямо в терминале: QR со страницы перерисовывается в консоли,
   * пользователь сканирует его телефоном (Настройки → Устройства → Подключить устройство).
   */
  async loginWithQr(ui: {
    showQr: (ascii: string) => void;
    askPassword: (hint: string | undefined, retry: boolean) => Promise<string>;
    info: (msg: string) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const s = this.opts.selectors;
    let lastToken: string | undefined;
    let passwordTries = 0;
    const deadline = Date.now() + 5 * 60_000;

    while (Date.now() < deadline) {
      if (ui.signal?.aborted) throw new Error("Вход прерван");
      const state = await this.detectState();
      if (state === "ready") return;

      if (state === "qr") {
        const token = await this.readQr();
        if (token && token !== lastToken) {
          lastToken = token;
          ui.showQr(await QRCode.toString(token, { type: "terminal", small: true, errorCorrectionLevel: "L" }));
        }
        await this.page.waitForTimeout(1000);
        continue;
      }

      // state === "password": на аккаунте включена двухэтапная проверка
      const input = this.page.locator(s.passwordInput).first();
      const hint = (await input.getAttribute("placeholder").catch(() => null)) ?? undefined;
      const password = await ui.askPassword(hint, passwordTries > 0);
      passwordTries++;
      await input.fill(password);
      await input.press("Enter");
      ui.info("Проверяю пароль…");
      // Ждём либо вход, либо ошибку (поле остаётся на месте)
      await this.page.waitForTimeout(3000);
    }
    throw new Error("Время на вход истекло (5 минут)");
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
  }
}
