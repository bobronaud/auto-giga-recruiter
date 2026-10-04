import * as p from "@clack/prompts";
import pc from "picocolors";
import type { AppConfig } from "../config/schema.js";
import type { BotButton, BotChatLike, BotMessage } from "../telegram/types.js";
import { askConfirm, askSelect } from "../ui/ask.js";
import { actionLine, botBubble } from "../ui/render.js";

export interface NavigationResult {
  vacancy?: string;
  /** Описание вакансии (из списка и первых сообщений бота) — для выбора резюме */
  context: string;
  /** Сообщения бота, пришедшие после выбора вакансии (первый ход интервью) */
  messages: BotMessage[];
  notes: string[];
}

/** Пользователь выбрал в меню «пройти все интервью подряд». */
export const BATCH = "batch" as const;

const NEXT_PAGE = /^(далее|дальше|ещё|еще|следующ|next|›|»|→|▶)/i;
const NUMBERED = /^\s*(\d+)\s*[.)]\s*(.+)$/s;

const usable = (b: BotButton) => b.kind !== "url";
const isNextPage = (b: BotButton) => usable(b) && NEXT_PAGE.test(b.text.trim());

/** Кнопка из списка вакансий: «4. Senior frontend разработчик (React)». */
export function isVacancyButton(b: BotButton): boolean {
  return usable(b) && NUMBERED.test(b.text) && !/[★☆]/.test(b.text);
}

/** Название вакансии без номера и лишних пробелов — ключ для учёта пройденных. */
export function vacancyKey(text: string): string {
  return (text.match(NUMBERED)?.[2] ?? text).replace(/\s+/g, " ").trim().toLowerCase();
}

/** Абзац про вакансию из сообщения со списком («4. Senior … \nВас ждёт: …»). */
export function vacancySnippet(listText: string, label: string): string {
  const num = label.match(NUMBERED)?.[1];
  const title = vacancyKey(label);
  const blocks = listText.split(/\n\s*\n/);
  const hit =
    (num && blocks.find((b) => new RegExp(`^\\s*${num}\\s*[.)]`).test(b))) ||
    blocks.find((b) => b.toLowerCase().includes(title));
  return hit?.trim() ?? "";
}

function matchVacancy(buttons: BotButton[], query: string): BotButton | undefined {
  const list = buttons.filter(usable);
  if (/^\d+$/.test(query)) return list.find((b) => b.index === Number(query));
  const q = query.toLowerCase();
  return list.find((b) => b.text.toLowerCase().includes(q));
}

function waiter(chat: BotChatLike, cfg: AppConfig, signal: AbortSignal) {
  return async (timeoutMs = cfg.behavior.botResponseTimeoutSec * 1000) => {
    const s = p.spinner();
    s.start("Ждём ответ бота…");
    const msgs = await chat.waitForBotTurn({ idleMs: cfg.behavior.botIdleMs, timeoutMs, signal });
    s.stop(msgs.length ? `Бот написал: ${msgs.length} сообщ.` : pc.yellow("Бот молчит"));
    msgs.forEach((m) => botBubble(m, chat.title));
    return msgs;
  };
}

const textOf = (msgs: BotMessage[]) => msgs.map((m) => m.text).filter(Boolean).join("\n\n");

/**
 * Нажимает кнопку вакансии и собирает её описание. Бот часто сначала пишет
 * «дайте мне несколько секунд», а описание присылает следующим сообщением — его тоже ждём.
 */
async function pickVacancy(
  chat: BotChatLike,
  cfg: AppConfig,
  btn: BotButton,
  listMsgs: BotMessage[],
  signal: AbortSignal,
): Promise<NavigationResult> {
  const wait = waiter(chat, cfg, signal);
  const snippet = vacancySnippet(textOf(listMsgs), btn.text);
  const res = await chat.click(btn.index);
  actionLine("👆", `выбрал «${res.label}»`);
  const notes = res.alert ? [`после выбора бот показал уведомление: «${res.alert}»`] : [];
  const messages = await wait();
  if (!signal.aborted && !messages.some((m) => m.buttons.length) && textOf(messages).length < 300) {
    messages.push(...(await wait(30_000)));
  }
  return { vacancy: res.label, context: [snippet, textOf(messages)].filter(Boolean).join("\n\n"), messages, notes };
}

/** Запрашивает список вакансий. Не через chat.start(): веб-драйвер там жмёт кнопку START, а /start бот не поддерживает. */
async function openVacancyList(chat: BotChatLike, cfg: AppConfig): Promise<void> {
  await chat.sendText(cfg.bot.vacancyCommand);
  actionLine("➤", `запросил список вакансий (${cfg.bot.vacancyCommand})`);
}

/** Сколько раз повторно запрашивать список, если бот промолчал. */
const LIST_RETRIES = 2;

/**
 * Этап до интервью: /change_vacancy → меню → выбор вакансии.
 * С --vacancy кнопка выбирается автоматически, иначе интерактивно.
 * После выбора вакансии управление переходит к ИИ.
 */
export async function navigateToVacancy(
  chat: BotChatLike,
  cfg: AppConfig,
  opts: { vacancy?: string; signal: AbortSignal },
): Promise<NavigationResult | typeof BATCH | undefined> {
  const wait = waiter(chat, cfg, opts.signal);
  let lastMsgs: BotMessage[] = [];

  // Бот периодически не отвечает — повторяем запрос, только если он промолчал.
  // Ответ без кнопок (например, «нет других вакансий») — тоже ответ, повторять его незачем.
  for (let attempt = 0; attempt <= LIST_RETRIES && !opts.signal.aborted; attempt++) {
    if (attempt) p.log.warn(`Бот не ответил, запрашиваю список ещё раз (${attempt}/${LIST_RETRIES})`);
    await openVacancyList(chat, cfg);
    lastMsgs = await wait();
    if (lastMsgs.length) break;
  }

  let autoMisses = 0;
  let pagesTurned = 0;
  const refresh = async () => {
    const msgs = await wait();
    if (msgs.length) lastMsgs = msgs;
  };

  while (!opts.signal.aborted) {
    const buttons = chat.currentButtons();

    // Автовыбор по --vacancy
    if (opts.vacancy) {
      const hit = matchVacancy(buttons, opts.vacancy);
      if (hit) return pickVacancy(chat, cfg, hit, lastMsgs, opts.signal);
      // Список вакансий может быть разбит на страницы
      const next = buttons.find(isNextPage);
      if (next && pagesTurned < 10) {
        pagesTurned++;
        const res = await chat.click(next.index);
        actionLine("👉", `листаю список: «${res.label}»`);
        await refresh();
        continue;
      }
      if (++autoMisses <= 2 && buttons.length) {
        // Возможно, это промежуточное меню: пробуем кнопку «вакансии»
        const menu = buttons.find((b) => /ваканс/i.test(b.text) && usable(b));
        if (menu) {
          const res = await chat.click(menu.index);
          actionLine("👆", `нажал «${res.label}»`);
          await refresh();
          continue;
        }
      }
      p.log.warn(`Кнопка вакансии «${opts.vacancy}» не найдена. Выбери вручную.`);
      opts.vacancy = undefined;
    }

    const choice = await askSelect<string>("Что делаем?", [
      ...buttons.filter(usable).map((b) => ({ value: `btn:${b.index}`, label: `👆 ${b.text}` })),
      { value: BATCH, label: "🚀 Пройти все интервью подряд", hint: "по очереди, без участия" },
      { value: "ai", label: "🤖 Передать управление ИИ", hint: "интервью уже началось" },
      { value: "quit", label: "✖ Выйти" },
    ]);

    if (choice === "quit") return undefined;
    if (choice === BATCH) return BATCH;
    // Вакансия к этому моменту уже выбрана в чате — ИИ просто продолжает с текущего места
    if (choice === "ai") return { context: textOf(lastMsgs), messages: lastMsgs, notes: [] };
    const btn = buttons.find((b) => `btn:${b.index}` === choice)!;
    if (isVacancyButton(btn) || (await askConfirm(`«${btn.text}» — это вакансия, по которой проходим интервью?`))) {
      return pickVacancy(chat, cfg, btn, lastMsgs, opts.signal);
    }
    const res = await chat.click(btn.index);
    actionLine("👆", `нажал «${res.label}»`);
    if (res.alert) actionLine("💬", res.alert);
    await refresh();
  }
  return undefined;
}

/** Учёт пакетного прохождения: сколько раз пробовали вакансию и сколько одноимённых видели в списке. */
export class BatchState {
  readonly attempts = new Map<string, number>();
  readonly maxSeen = new Map<string, number>();

  /**
   * Следующая непройденная вакансия среди кнопок. Бот обычно убирает пройденные из списка,
   * но на случай, если нет, одноимённые вакансии («Senior frontend (React)» ×2) берём по очереди.
   */
  choose(buttons: BotButton[]): BotButton | undefined {
    const groups = new Map<string, BotButton[]>();
    for (const b of buttons.filter(isVacancyButton)) {
      const k = vacancyKey(b.text);
      groups.set(k, [...(groups.get(k) ?? []), b]);
    }
    for (const [k, list] of groups) this.maxSeen.set(k, Math.max(this.maxSeen.get(k) ?? 0, list.length));
    for (const [k, list] of groups) {
      const tried = this.attempts.get(k) ?? 0;
      if (tried >= this.maxSeen.get(k)!) continue;
      this.attempts.set(k, tried + 1);
      return list[Math.min(tried, list.length - 1)];
    }
    return undefined;
  }
}

/**
 * Пакетный режим: находит следующую непройденную вакансию (листая список и
 * при необходимости перезапуская бота) и выбирает её. undefined — пройдено всё.
 */
export async function nextBatchVacancy(
  chat: BotChatLike,
  cfg: AppConfig,
  state: BatchState,
  signal: AbortSignal,
): Promise<NavigationResult | undefined> {
  const wait = waiter(chat, cfg, signal);
  let listMsgs = (await chat.history(3)).filter((m) => !m.out);
  let pages = 0;
  let menuClicks = 0;
  let restarts = 0;

  while (!signal.aborted) {
    const buttons = chat.currentButtons();
    const hasList = buttons.some(isVacancyButton);
    if (hasList) {
      const target = state.choose(buttons);
      if (target) return pickVacancy(chat, cfg, target, listMsgs, signal);
      const next = buttons.find(isNextPage);
      if (next && pages < 10) {
        pages++;
        const res = await chat.click(next.index);
        actionLine("👉", `листаю список: «${res.label}»`);
        listMsgs = await wait();
        continue;
      }
      if (!pages) return undefined;
    }
    // Списка нет (или долистали до конца): пробуем меню «вакансии», затем /change_vacancy
    const menu = buttons.find((b) => usable(b) && /ваканс/i.test(b.text) && !isVacancyButton(b));
    if (!hasList && menu && menuClicks < 2) {
      menuClicks++;
      const res = await chat.click(menu.index);
      actionLine("👆", `нажал «${res.label}»`);
      listMsgs = await wait();
      continue;
    }
    // Повторяем, только пока бот молчит: ответ без списка («нет других вакансий») — конец пакета
    if (restarts < LIST_RETRIES && !(restarts && listMsgs.length)) {
      restarts++;
      pages = 0;
      await openVacancyList(chat, cfg);
      listMsgs = await wait();
      continue;
    }
    return undefined;
  }
  return undefined;
}
