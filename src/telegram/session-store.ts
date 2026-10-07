import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Хранилище строки сессии GramJS.
 *
 * Формат файла:
 *   plain:<session>                               — без пароля
 *   enc:v1:<salt b64>:<iv b64>:<tag b64>:<data b64> — AES-256-GCM, ключ = scrypt(passphrase, salt)
 *
 * Файл создаётся с правами 600 и лежит в gitignored-директории data/.
 */
export class SessionStore {
  readonly path: string;

  constructor(
    dataDir: string,
    private readonly passphrase?: string,
  ) {
    this.path = join(dataDir, "session.enc");
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  load(): string {
    if (!this.exists()) return "";
    const raw = readFileSync(this.path, "utf8").trim();
    if (raw.startsWith("plain:")) return raw.slice("plain:".length);
    if (raw.startsWith("enc:v1:")) {
      if (!this.passphrase) {
        throw new Error("Сессия зашифрована, но SESSION_PASSPHRASE не задан в .env");
      }
      const [, , saltB64, ivB64, tagB64, dataB64] = raw.split(":");
      if (!saltB64 || !ivB64 || !tagB64 || !dataB64) throw new Error("Повреждённый файл сессии");
      const key = scryptSync(this.passphrase, Buffer.from(saltB64, "base64"), 32);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
      decipher.setAuthTag(Buffer.from(tagB64, "base64"));
      try {
        return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
      } catch {
        throw new Error("Не удалось расшифровать сессию: неверный SESSION_PASSPHRASE?");
      }
    }
    throw new Error(`Неизвестный формат файла сессии: ${this.path}`);
  }

  save(session: string): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    let payload: string;
    if (this.passphrase) {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const key = scryptSync(this.passphrase, salt, 32);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(session, "utf8"), cipher.final()]);
      payload = ["enc", "v1", salt, iv, cipher.getAuthTag(), data]
        .map((p) => (typeof p === "string" ? p : p.toString("base64")))
        .join(":");
    } else {
      payload = `plain:${session}`;
    }
    writeFileSync(this.path, payload, { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  isEncrypted(): boolean {
    return this.exists() && readFileSync(this.path, "utf8").startsWith("enc:");
  }

  remove(): void {
    rmSync(this.path, { force: true });
  }
}
