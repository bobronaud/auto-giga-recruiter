import * as p from "@clack/prompts";

export class UserCancelled extends Error {
  constructor() {
    super("Отменено пользователем");
  }
}

/** Разворачивает результат clack-промпта: при Ctrl+C / Esc бросает UserCancelled. */
export function unwrap<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new UserCancelled();
  return value as Exclude<T, symbol>;
}

export async function askText(message: string, opts: { placeholder?: string; initialValue?: string; required?: boolean } = {}) {
  return unwrap(
    await p.text({
      message,
      placeholder: opts.placeholder,
      initialValue: opts.initialValue,
      validate: opts.required ? (v) => (v && v.trim() ? undefined : "Обязательное поле") : undefined,
    }),
  ).trim();
}

export async function askSecret(message: string) {
  return unwrap(await p.password({ message, mask: "•" }));
}

export async function askSelect<T extends string>(message: string, options: Array<{ value: T; label: string; hint?: string }>) {
  return unwrap(await p.select<T>({ message, options: options as never }));
}

export async function askConfirm(message: string, initialValue = true) {
  return unwrap(await p.confirm({ message, initialValue }));
}
