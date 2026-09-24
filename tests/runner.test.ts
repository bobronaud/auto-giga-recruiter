import { describe, expect, it } from "vitest";
import type { InterviewAction } from "../src/llm/action.js";
import type { Brain } from "../src/llm/brain.js";

// Сценарий ответов «Claude»
const script: InterviewAction[] = [];
const prompts: string[] = [];
const fakeBrain = (): Brain => ({
  provider: "api",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 },
  async decide(p: string) {
    prompts.push(p);
    return script.shift()!;
  },
  async revise(p: string) {
    prompts.push(p);
    return script.shift()!;
  },
});

const { runInterview } = await import("../src/interview/runner.js");
const { configSchema } = await import("../src/config/schema.js");
const { Transcript } = await import("../src/storage/transcripts.js");

function fakeChannel(turns: Array<{ text: string; buttons?: string[] }>) {
  const sent: string[] = [];
  const clicked: number[] = [];
  let buttons: any[] = [];
  let id = 1;
  return {
    sent,
    clicked,
    title: "fake",
    async waitForBotTurn() {
      const t = turns.shift();
      if (!t) return [];
      buttons = (t.buttons ?? []).map((text, index) => ({ index, row: 0, col: index, text, kind: "inline" }));
      return [{ id: id++, date: 0, text: t.text, buttons, edited: false, out: false }];
    },
    currentButtons: () => buttons,
    async click(i: number) {
      clicked.push(i);
      return { label: buttons[i].text };
    },
    async sendText(text: string) {
      sent.push(text);
    },
  };
}

const act = (a: Partial<InterviewAction> & Pick<InterviewAction, "action">): InterviewAction => ({
  text: "",
  button_index: -1,
  reason: "test",
  ...a,
});

describe("runInterview", () => {
  it("кнопка → ответ (с сокращением) → finish, лимит символов соблюдён", async () => {
    const cfg = configSchema.parse({ answers: { maxChars: 50 }, logging: { saveTranscripts: false } });
    const ch = fakeChannel([
      { text: "Готовы начать?", buttons: ["Начать", "Позже"] },
      { text: "Расскажите о себе" },
      { text: "Спасибо, интервью окончено!" },
    ]);
    script.push(
      act({ action: "click", button_index: 7 }), // несуществующая кнопка → revise
      act({ action: "click", button_index: 0 }),
      act({ action: "reply", text: "x".repeat(120) }), // длиннее лимита → revise
      act({ action: "reply", text: "y".repeat(80) }), // всё ещё длинно → revise
      act({ action: "reply", text: "z".repeat(70) }), // попытки кончились → обрезка
      act({ action: "finish", reason: "бот попрощался" }),
    );
    const res = await runInterview({
      channel: ch,
      cfg,
      brain: fakeBrain(),
      vacancy: "Backend",
      mode: "auto",
      transcript: new Transcript("/tmp", false),
      signal: new AbortController().signal,
      noTyping: true,
    });
    expect(ch.clicked).toEqual([0]);
    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]!.length).toBeLessThanOrEqual(50);
    expect(res.reason).toContain("бот попрощался");
    expect(res.replies).toBe(1);
    expect(prompts[0]).toContain("Выбрана вакансия: «Backend»");
    expect(prompts[0]).toContain("[0] Начать");
    expect(prompts.some((p) => p.includes("кнопки с индексом 7 нет"))).toBe(true);
    // Следующий ход сообщает модели, что отправлен обрезанный текст
    expect(prompts.at(-1)).toContain("фактически отправлен другой текст");
  });

  it("останавливается, если бот дважды молчит", async () => {
    const cfg = configSchema.parse({ logging: { saveTranscripts: false } });
    const ch = fakeChannel([]);
    script.length = 0;
    script.push(act({ action: "wait" }));
    const res = await runInterview({
      channel: ch,
      cfg,
      brain: fakeBrain(),
      mode: "auto",
      transcript: new Transcript("/tmp", false),
      signal: new AbortController().signal,
      noTyping: true,
    });
    expect(res.reason).toContain("не отвечает");
    expect(ch.sent).toHaveLength(0);
  });

  it("ответ с иероглифом уходит на переделку, тире заменяются дефисом", async () => {
    const cfg = configSchema.parse({ logging: { saveTranscripts: false } });
    const ch = fakeChannel([{ text: "Чем заинтересовала вакансия?" }, { text: "Спасибо!" }]);
    script.length = 0;
    prompts.length = 0;
    script.push(
      act({ action: "reply", text: "Продуктовая работа в長ом горизонте — это важно" }),
      act({ action: "reply", text: "Продуктовая работа в долгом горизонте — это важно" }),
      act({ action: "finish" }),
    );
    await runInterview({
      channel: ch,
      cfg,
      brain: fakeBrain(),
      mode: "auto",
      transcript: new Transcript("/tmp", false),
      signal: new AbortController().signal,
      noTyping: true,
    });
    expect(prompts.some((p) => p.includes("長"))).toBe(true);
    expect(ch.sent).toEqual(["Продуктовая работа в долгом горизонте - это важно"]);
  });
});
