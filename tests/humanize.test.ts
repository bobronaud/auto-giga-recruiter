import { describe, expect, it } from "vitest";
import { foreignChars, humanize, stripForeign } from "../src/llm/humanize.js";

describe("humanize", () => {
  it("заменяет типографику на символы с клавиатуры", () => {
    expect(humanize("Опыт — 3 года, «сдал и ушёл»… Итог → рост")).toBe('Опыт - 3 года, "сдал и ушёл"... Итог - рост');
  });

  it("маркеры списка и неразрывные пробелы", () => {
    expect(humanize("• React\n• Vue 3")).toBe("- React\n- Vue 3");
  });

  it("после замены не остаётся чужих символов в обычном тексте", () => {
    expect(foreignChars(humanize("Работал с NestJS + PostgreSQL — №1 «в команде»"))).toEqual([]);
  });

  it("находит иероглифы и убирает их в крайнем случае", () => {
    expect(foreignChars("работа в長ом горизонте")).toEqual(["長"]);
    expect(stripForeign("ок 👍 長")).toBe("ок");
  });
});
