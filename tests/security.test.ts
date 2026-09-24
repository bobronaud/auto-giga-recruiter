import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/telegram/session-store.js";
import { maskPhone, redact, registerSecret } from "../src/util/redact.js";

describe("redact", () => {
  it("маскирует ключ Anthropic и зарегистрированные секреты", () => {
    registerSecret("+79991234567");
    const out = redact("key sk-ant-api03-abcdefghijklmnop phone +79991234567");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("79991234567");
  });

  it("маскирует длинную строку сессии", () => {
    const session = "1" + "A".repeat(300);
    expect(redact(`session=${session}`)).toContain("<session:***>");
  });

  it("maskPhone", () => {
    expect(maskPhone("+7 999 123-45-67")).toBe("+7******67");
  });
});

describe("SessionStore", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "agr-"));

  it("шифрует сессию при заданном пароле и расшифровывает её", () => {
    const d = dir();
    const s = new SessionStore(d, "correct horse");
    s.save("SESSION_VALUE_123");
    const raw = readFileSync(s.path, "utf8");
    expect(raw).not.toContain("SESSION_VALUE_123");
    expect(raw.startsWith("enc:v1:")).toBe(true);
    expect(s.load()).toBe("SESSION_VALUE_123");
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
  });

  it("неверный пароль — ошибка", () => {
    const d = dir();
    new SessionStore(d, "right").save("X");
    expect(() => new SessionStore(d, "wrong").load()).toThrow(/расшифровать/);
  });

  it("без пароля — plain, права 600", () => {
    const d = dir();
    const s = new SessionStore(d);
    s.save("Y");
    expect(s.load()).toBe("Y");
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
  });
});
