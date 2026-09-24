import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TelegramWeb } from "../src/telegram/web/browser.js";
import { defaultSelectors } from "../src/telegram/web/selectors.js";
import { WebBotChat } from "../src/telegram/web/web-chat.js";

/**
 * Фейковая страница с разметкой Telegram Web K: бот отвечает на сообщения,
 * присылает inline-кнопки, реагирует на нажатия. Проверяет парсинг, клики и ввод текста
 * без реального Telegram.
 */
const FAKE_TG = String.raw`<!doctype html><html><body>
<div class="chats-container">
<div class="chat active">
  <div class="chat-info"><span class="peer-title">ГигаРекрутер</span></div>
  <div class="bubbles">
    <div class="bubbles-remover-container"><div class="bubbles-remover bubbles-inner"></div></div>
    <div class="scrollable bubbles-scrollable"><div class="bubbles-inner has-rights"></div></div>
  </div>
  <div class="chat-input">
    <div class="chat-input-control"><button class="chat-input-control-button"><i class="icon"></i></button></div>
    <div class="input-message-input" contenteditable="true"></div>
    <div class="input-message-input input-field-input-fake" contenteditable="true"></div>
    <button class="btn-send">send</button>
  </div>
</div>
</div>
<script>
  let mid = 100;
  const inner = document.querySelector(".bubbles-scrollable .bubbles-inner");
  function add(out, text, rows) {
    const b = document.createElement("div");
    b.className = "bubble " + (out ? "is-out" : "is-in");
    b.dataset.mid = String(++mid);
    b.dataset.timestamp = String(Math.floor(Date.now() / 1000));
    let html = '<div class="message">' + text + '<span class="time"><span class="time-inner">12:00</span></span>';
    if (rows) {
      html += '<div class="reply-markup">' + rows.map(r => '<div class="reply-markup-row">' +
        r.map(t => '<button class="reply-markup-button"><span class="reply-markup-button-text">' + t + '</span></button>').join("") +
        '</div>').join("") + '</div>';
    }
    b.innerHTML = html + '</div>';
    inner.appendChild(b);
    return b;
  }
  window.__add = add;
  add(false, "Старое сообщение", [["Старая кнопка"]]);
  const input = document.querySelector(".input-message-input:not(.input-field-input-fake)");
  function send() {
    const text = input.innerText.trim();
    if (!text) return;
    input.innerText = "";
    add(true, text);
    window.__sent = (window.__sent || []).concat(text);
    setTimeout(() => {
      if (text === "/start") add(false, "Ваши вакансии:", [["Java-разработчик", "Аналитик"], ["Помощь"]]);
      else add(false, "Принято: " + text.length + " симв.");
    }, 150);
  }
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  document.querySelector(".btn-send").onclick = send;
  inner.addEventListener("click", (e) => {
    const btn = e.target.closest(".reply-markup-button");
    if (!btn) return;
    const label = btn.innerText.trim();
    setTimeout(() => add(false, "Вы выбрали вакансию «" + label + "». Начнём?", [["Начать интервью"]]), 150);
  });
</script></body></html>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.route("https://web.telegram.org/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: FAKE_TG }),
  );
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

const fakeWeb = () =>
  ({ page, opts: { url: "https://web.telegram.org/k/", headless: true, profileDir: "", selectors: { ...defaultSelectors } } }) as unknown as TelegramWeb;

const wait = { idleMs: 400, timeoutMs: 5000 };

describe("WebBotChat (фейковый Telegram Web)", () => {
  it("открывает чат, отправляет /start, видит кнопки, нажимает их и отвечает текстом", async () => {
    const chat = await WebBotChat.open(fakeWeb(), "GigaRecruiterBot", 100);
    try {
      expect(chat.title).toBe("ГигаРекрутер");
      // История видна, но в очередь не попадает
      const hist = await chat.history();
      expect(hist.at(-1)?.text).toBe("Старое сообщение");
      expect(chat.drain()).toHaveLength(0);

      await chat.start("/start");
      const first = await chat.waitForBotTurn(wait);
      expect(first.map((m) => m.text)).toEqual(["Ваши вакансии:"]);
      expect(first[0]!.text).not.toContain("12:00"); // время вырезано
      expect(chat.currentButtons().map((b) => `${b.index}:${b.row}:${b.col}:${b.text}`)).toEqual([
        "0:0:0:Java-разработчик",
        "1:0:1:Аналитик",
        "2:1:0:Помощь",
      ]);

      const res = await chat.click(1);
      expect(res.label).toBe("Аналитик");
      const second = await chat.waitForBotTurn(wait);
      expect(second[0]!.text).toContain("«Аналитик»");
      expect(chat.currentButtons().map((b) => b.text)).toEqual(["Начать интервью"]);

      const answer = "Первая строка ответа.\nВторая строка.";
      await chat.sendText(answer, 300);
      const third = await chat.waitForBotTurn(wait);
      expect(third[0]!.text).toMatch(/^Принято: \d+ симв\.$/);
      const sent = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
      expect(sent.at(-1)).toContain("Первая строка ответа.");
      expect(sent.at(-1)).toContain("Вторая строка.");
      // Новое сообщение без кнопок убирает устаревшие inline-кнопки
      expect(chat.currentButtons()).toHaveLength(0);
    } finally {
      chat.close();
    }
  }, 30_000);

  it("замечает правку сообщения бота", async () => {
    const chat = await WebBotChat.open(fakeWeb(), "GigaRecruiterBot", 100);
    try {
      await page.evaluate(() => {
        const w = window as unknown as { __add: (out: boolean, t: string) => HTMLElement; __last: HTMLElement };
        w.__last = w.__add(false, "Вопрос 1");
      });
      const a = await chat.waitForBotTurn(wait);
      expect(a[0]!.edited).toBe(false);
      await page.evaluate(() => {
        const w = window as unknown as { __last: HTMLElement };
        w.__last.querySelector(".message")!.firstChild!.textContent = "Вопрос 1 (уточнён)";
      });
      const b = await chat.waitForBotTurn(wait);
      expect(b[0]!.edited).toBe(true);
      expect(b[0]!.text).toBe("Вопрос 1 (уточнён)");
    } finally {
      chat.close();
    }
  }, 30_000);
});
