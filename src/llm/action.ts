import { z } from "zod";

/**
 * Решение ИИ на каждом шаге интервью.
 * Плоская схема (без union) — надёжно работает со structured outputs.
 */
export const actionSchema = z.object({
  action: z
    .enum(["reply", "click", "wait", "finish"])
    .describe("reply — отправить текст; click — нажать кнопку; wait — ждать следующего сообщения; finish — интервью окончено"),
  text: z.string().describe("Текст ответа для action=reply, иначе пустая строка"),
  button_index: z.number().int().describe("Индекс кнопки для action=click, иначе -1"),
  reason: z.string().describe("Короткое пояснение решения для лога (1 предложение)"),
});

export type InterviewAction = z.infer<typeof actionSchema>;

/** Приводит ответ к лимиту: обрезает по границе предложения, затем слова. */
export function fitToLimit(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  const slice = t.slice(0, maxChars);
  const sentenceEnd = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "), slice.lastIndexOf("\n"));
  if (sentenceEnd >= maxChars * 0.5) return slice.slice(0, sentenceEnd + 1).trim();
  const room = t.slice(0, Math.max(0, maxChars - 3));
  const wordEnd = room.lastIndexOf(" ");
  const cut = wordEnd > maxChars * 0.5 ? room.slice(0, wordEnd) : room;
  return cut.replace(/[\s,;:—-]+$/, "") + "...";
}
