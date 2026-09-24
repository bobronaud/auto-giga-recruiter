import boxen from "boxen";
import pc from "picocolors";
import type { BotButton, BotMessage } from "../telegram/types.js";

const width = () => Math.max(40, Math.min(process.stdout.columns ?? 80, 100));
const bubbleWidth = () => Math.min(72, width() - 6);

export function banner(): void {
  const title = pc.bold(pc.green("  auto-giga-recruiter  "));
  const sub = pc.dim("ИИ-интервью в ГигаРекрутере на автопилоте");
  console.log(
    boxen(`${title}\n${sub}`, {
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      borderStyle: "round",
      borderColor: "green",
      textAlignment: "center",
    }),
  );
}

function buttonsLine(buttons: BotButton[]): string {
  if (!buttons.length) return "";
  return (
    "\n" +
    buttons
      .map((b) => {
        const chip = ` ${b.index} │ ${b.text} `;
        return b.kind === "url" ? pc.dim(pc.underline(chip)) : pc.inverse(chip);
      })
      .join(" ")
  );
}

export function botBubble(msg: BotMessage, title = "ГигаРекрутер"): void {
  const media = msg.media ? pc.yellow(`[${msg.media}] `) : "";
  const edited = msg.edited ? pc.dim(" (изм.)") : "";
  const body = `${media}${msg.text || pc.dim("(без текста)")}${buttonsLine(msg.buttons)}`;
  console.log(
    boxen(body, {
      title: pc.cyan(`🤖 ${title}${edited}`),
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      borderStyle: "round",
      borderColor: "cyan",
      width: bubbleWidth(),
    }),
  );
}

export function meBubble(text: string, meta?: string): void {
  console.log(
    boxen(text, {
      title: pc.green("🧑 Я") + (meta ? pc.dim(` · ${meta}`) : ""),
      titleAlignment: "right",
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
      borderStyle: "round",
      borderColor: "green",
      width: bubbleWidth(),
      float: "right",
    }),
  );
}

export function actionLine(icon: string, text: string): void {
  console.log(`${" ".repeat(Math.max(0, width() - bubbleWidth() - 2))}${pc.dim(`${icon} ${text}`)}`);
}

export function charMeter(len: number, max: number): string {
  const ratio = len / max;
  const color = ratio > 1 ? pc.red : ratio > 0.85 ? pc.yellow : pc.green;
  return color(`${len}/${max} симв.`);
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m ? `${m} мин ${s % 60} с` : `${s} с`;
}
