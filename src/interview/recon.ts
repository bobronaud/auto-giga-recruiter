import * as p from "@clack/prompts";
import Table from "cli-table3";
import pc from "picocolors";
import type { AppConfig } from "../config/schema.js";
import { Transcript } from "../storage/transcripts.js";
import { writeFileSync } from "node:fs";
import type { BotChatLike, BotMessage } from "../telegram/types.js";
import { askSelect, askText } from "../ui/ask.js";
import { actionLine, botBubble } from "../ui/render.js";

function details(m: BotMessage): void {
  const info = [
    `id=${m.id}`,
    `date=${new Date(m.date * 1000).toLocaleString()}`,
    m.media ? `media=${m.media}` : "",
    m.edited ? "edited" : "",
    m.meta ? `meta=${JSON.stringify(m.meta)}` : "",
  ]
    .filter(Boolean)
    .join("  ");
  console.log(pc.dim(`   ${info}`));
  if (m.buttons.length) {
    const t = new Table({ head: ["#", "row:col", "kind", "text", "data / url"], style: { head: ["cyan"] } });
    m.buttons.forEach((b) => t.push([b.index, `${b.row}:${b.col}`, b.kind, b.text, b.data ?? b.url ?? ""]));
    console.log(t.toString());
  }
}

function snapshot(m: BotMessage) {
  return {
    id: m.id,
    date: m.date,
    text: m.text,
    media: m.media,
    edited: m.edited,
    out: m.out,
    meta: m.meta,
    buttons: m.buttons,
  };
}

/**
 * Разведка: показывает всё, что присылает бот (текст, медиа, кнопки с callback data),
 * и сохраняет дамп в data/recon/. В обычном режиме ничего не отправляет, кроме команды списка вакансий (/change_vacancy).
 */
export async function runRecon(
  chat: BotChatLike,
  cfg: AppConfig,
  opts: { interactive: boolean; history: number; send: boolean; signal: AbortSignal },
): Promise<string | undefined> {
  const dump = new Transcript(cfg.logging.dir, true, "recon");
  dump.meta = { bot: cfg.bot.username };
  const log = (m: BotMessage, source: string) => {
    botBubble(m, chat.title);
    details(m);
    dump.add({ role: m.out ? "me" : "bot", text: JSON.stringify({ source, ...snapshot(m) }) });
  };

  if (opts.history > 0) {
    p.log.step(`Последние ${opts.history} сообщений чата:`);
    for (const m of await chat.history(opts.history)) {
      if (m.out) actionLine("🧑", m.text);
      else log(m, "history");
    }
  }

  if (opts.send) {
    // Не chat.start(): веб-драйвер там жмёт кнопку START, а /start бот не поддерживает
    await chat.sendText(cfg.bot.vacancyCommand);
    actionLine("➤", `запросил список вакансий (${cfg.bot.vacancyCommand})`);
  }
  await saveHtml();

  p.log.info(opts.interactive ? "Интерактивная разведка: управляй ботом вручную." : "Слушаю бота. Ctrl+C — выход.");

  while (!opts.signal.aborted) {
    const s = p.spinner();
    s.start("Жду сообщений…");
    const msgs = await chat.waitForBotTurn({
      idleMs: cfg.behavior.botIdleMs,
      timeoutMs: (opts.interactive ? 30 : 600) * 1000,
      signal: opts.signal,
    });
    s.stop(msgs.length ? `Получено: ${msgs.length}` : pc.dim("Тишина"));
    msgs.forEach((m) => log(m, "live"));
    if (msgs.length) await saveHtml();
    if (!opts.interactive || opts.signal.aborted) continue;

    const buttons = chat.currentButtons().filter((b) => b.kind !== "url");
    const choice = await askSelect<string>("Действие", [
      ...buttons.map((b) => ({ value: `btn:${b.index}`, label: `👆 ${b.text}` })),
      { value: "text", label: "✍️  Написать текст" },
      { value: "wait", label: "⏳ Ждать дальше" },
      { value: "quit", label: "✖ Выйти" },
    ]);
    if (choice === "quit") break;
    if (choice === "wait") continue;
    if (choice === "text") {
      const text = await askText("Текст", { required: true });
      await chat.sendText(text);
      dump.add({ role: "me", text });
      continue;
    }
    const idx = Number(choice.slice(4));
    const res = await chat.click(idx);
    actionLine("👆", `нажал «${res.label}»${res.alert ? ` → уведомление: ${res.alert}` : ""}`);
    dump.add({ role: "me", text: `click #${idx} ${res.label}`, action: "click" });
  }
  await saveHtml();
  return dump.path;

  /** В web-режиме сохраняем HTML чата рядом с дампом — по нему правятся селекторы. */
  async function saveHtml() {
    if (!chat.debugDump) return;
    const json = dump.flush();
    if (!json) return;
    const html = await chat.debugDump().catch(() => "");
    if (html) writeFileSync(json.replace(/\.json$/, ".html"), html, { mode: 0o600 });
  }
}
