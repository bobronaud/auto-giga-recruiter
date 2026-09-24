import { describe, expect, it } from "vitest";
import { actionSchema, fitToLimit } from "../src/llm/action.js";

describe("fitToLimit", () => {
  it("не трогает короткий текст", () => {
    expect(fitToLimit("  Привет  ", 100)).toBe("Привет");
  });

  it("режет по границе предложения", () => {
    const t = "Первое предложение. Второе предложение подлиннее. Третье.";
    const r = fitToLimit(t, 30);
    expect(r).toBe("Первое предложение.");
    expect(r.length).toBeLessThanOrEqual(30);
  });

  it("режет по слову и ставит многоточие", () => {
    const t = "слово ".repeat(50);
    const r = fitToLimit(t, 40);
    expect(r.length).toBeLessThanOrEqual(40);
    expect(r.endsWith("...")).toBe(true);
  });

  it("всегда укладывается в лимит", () => {
    for (let max = 5; max < 200; max += 7) {
      expect(fitToLimit("абв".repeat(100), max).length).toBeLessThanOrEqual(max);
    }
  });
});

describe("actionSchema", () => {
  it("парсит валидное действие", () => {
    const a = actionSchema.parse({ action: "click", text: "", button_index: 2, reason: "начать" });
    expect(a.action).toBe("click");
  });

  it("отклоняет неизвестное действие", () => {
    expect(() => actionSchema.parse({ action: "hack", text: "", button_index: -1, reason: "" })).toThrow();
  });
});
