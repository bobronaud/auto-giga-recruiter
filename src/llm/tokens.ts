/** Грубая оценка по UTF-8-байтам; не токенизатор модели и не основание для расчёта оплаты. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}
