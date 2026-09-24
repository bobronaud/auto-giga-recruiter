import { describe, expect, it } from "vitest";
import { pickResume, type Resume } from "../src/resumes/loader.js";
import { typingDelayMs } from "../src/interview/runner.js";
import { configSchema } from "../src/config/schema.js";

const r = (file: string, isExample = false): Resume => ({ file, path: file, content: "x", isExample });

describe("pickResume", () => {
  const cfg = configSchema.parse({}).resumes;

  it("единственное нешаблонное резюме выбирается автоматически", () => {
    expect(pickResume([r("example.md", true), r("me.md")], cfg, {})?.file).toBe("me.md");
  });

  it("perVacancy с (?i)", () => {
    const c = { ...cfg, perVacancy: [{ match: "(?i)frontend", resume: "front.md" }] };
    expect(pickResume([r("back.md"), r("front.md")], c, { vacancy: "Senior FrontEnd Dev" })?.file).toBe("front.md");
  });

  it("неоднозначно — первое нешаблонное, без вопросов", () => {
    expect(pickResume([r("a.md"), r("b.md")], cfg, {})?.file).toBe("a.md");
  });

  const stack = [r("example.md", true), r("resume.react.md"), r("resume.vue.md")];

  it("vue в описании вакансии — резюме vue", () => {
    const ctx = "Команда пишет личный кабинет на Vue 3 и Nuxt, стейт в Pinia.";
    expect(pickResume(stack, cfg, { vacancy: "Frontend-разработчик", context: ctx })?.file).toBe("resume.vue.md");
  });

  it("react в названии вакансии — резюме react", () => {
    expect(pickResume(stack, cfg, { vacancy: "Senior frontend разработчик (React)" })?.file).toBe("resume.react.md");
  });

  it("стек не указан или ничья — фолбэк на react", () => {
    expect(pickResume(stack, cfg, { vacancy: "QA-инженер fullstack" })?.file).toBe("resume.react.md");
    expect(pickResume(stack, cfg, { vacancy: "Frontend", context: "React или Vue" })?.file).toBe("resume.react.md");
    expect(pickResume(stack, cfg, {})?.file).toBe("resume.react.md");
  });

  it("не путает подстроки: reactive не считается react", () => {
    expect(pickResume([r("resume.vue.md"), r("resume.react.md")], cfg, { context: "reactive streams, Vue" })?.file).toBe(
      "resume.vue.md",
    );
  });

  it("явное имя без расширения", () => {
    expect(pickResume([r("a.md"), r("b.md")], cfg, { explicit: "b" })?.file).toBe("b.md");
  });
});

describe("typingDelayMs", () => {
  const b = configSchema.parse({}).behavior;
  it("в пределах min..max с разбросом", () => {
    for (const len of [1, 100, 10000]) {
      const d = typingDelayMs(len, b, 0);
      expect(d).toBeGreaterThanOrEqual(b.typingDelay.minMs * 0.85 - 1);
      expect(d).toBeLessThanOrEqual(b.typingDelay.maxMs * 1.15 + 1);
    }
  });
  it("уважает таймер вопроса", () => {
    expect(typingDelayMs(10000, { ...b, questionTimeoutSec: 10 }, 4000)).toBeLessThanOrEqual(1000);
  });
});
