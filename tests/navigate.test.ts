import { describe, expect, it } from "vitest";
import { BatchState, isVacancyButton, vacancyKey, vacancySnippet } from "../src/interview/navigate.js";
import type { BotButton } from "../src/telegram/types.js";

const btns = (...texts: string[]): BotButton[] => texts.map((text, index) => ({ index, row: index, col: 0, text, kind: "inline" }));

describe("список вакансий", () => {
  it("распознаёт кнопки вакансий", () => {
    const [a, b, c] = btns("4. Senior frontend разработчик (React)", "Далее", "★★★★★");
    expect(isVacancyButton(a!)).toBe(true);
    expect(isVacancyButton(b!)).toBe(false);
    expect(isVacancyButton(c!)).toBe(false);
    expect(vacancyKey("4. Senior  frontend (React)")).toBe("senior frontend (react)");
  });

  it("достаёт описание вакансии из сообщения со списком", () => {
    const list = "По какой продолжить?\n\n1. QA-инженер\nВас ждёт: тестирование.\n\n2. Frontend (Vue)\nВас ждёт: Nuxt и Pinia.";
    expect(vacancySnippet(list, "2. Frontend (Vue)")).toContain("Nuxt и Pinia");
  });
});

describe("BatchState", () => {
  it("бот убирает пройденные: идём по списку, дубли тоже проходим", () => {
    const s = new BatchState();
    expect(s.choose(btns("1. A", "2. Dup", "3. Dup", "Далее"))?.text).toBe("1. A");
    expect(s.choose(btns("1. Dup", "2. Dup", "Далее"))?.text).toBe("1. Dup");
    expect(s.choose(btns("1. Dup", "Далее"))?.text).toBe("1. Dup");
    expect(s.choose(btns("Далее"))).toBeUndefined();
  });

  it("бот не убирает пройденные: не зацикливаемся и берём второй дубль", () => {
    const s = new BatchState();
    const list = btns("1. A", "2. Dup", "3. Dup");
    expect(s.choose(list)?.text).toBe("1. A");
    expect(s.choose(list)?.text).toBe("2. Dup");
    expect(s.choose(list)?.text).toBe("3. Dup");
    expect(s.choose(list)).toBeUndefined();
  });
});
