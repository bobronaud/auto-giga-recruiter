/**
 * Маскирует чувствительные данные перед выводом в консоль / записью на диск.
 * Применяется только к логам и сообщениям об ошибках — не к тексту, который уходит в Telegram.
 */
const patterns: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, "sk-ant-***"],
  // GramJS StringSession: base64, начинается с "1", очень длинная
  [/\b1[A-Za-z0-9+/=_-]{200,}/g, "<session:***>"],
];

const secrets = new Set<string>();

/** Регистрирует конкретное значение (телефон, api hash, ключ), которое нужно вырезать из любого вывода. */
export function registerSecret(value: string | number | undefined | null): void {
  const s = value == null ? "" : String(value);
  if (s.length >= 6) secrets.add(s);
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return "***";
  return `+${digits.slice(0, 1)}******${digits.slice(-2)}`;
}

export function redact(input: string): string {
  let out = input;
  for (const s of secrets) out = out.split(s).join("***");
  for (const [re, repl] of patterns) out = out.replace(re, repl);
  return out;
}

export function redactError(err: unknown): string {
  if (err instanceof Error) return redact(err.message);
  return redact(String(err));
}
