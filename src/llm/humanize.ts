/**
 * Приводит ответ к виду «набрал человек на обычной клавиатуре»:
 * длинные тире, ёлочки, многоточие-символ, стрелки и т.п. заменяются на обычные символы.
 */
const REPLACEMENTS: Array<[RegExp, string]> = [
  [/[  -   　]/g, " "], // неразрывные и «тонкие» пробелы
  [/[​-‍⁠﻿­]/g, ""], // невидимые символы, мягкий перенос
  [/[‐-―−⸺⸻]/g, "-"], // все виды тире и минуса
  [/[«»„“”‟″〝〞]/g, '"'],
  [/[‘’‚‛′`]/g, "'"],
  [/…/g, "..."],
  [/\s*[→⇒⟶➝➔➜►▶]\s*/g, " - "],
  [/[←⇐⟵◄◀]/g, "<-"],
  [/^[ \t]*[•·▪▫◦●○■□✓✔☑]\s*/gm, "- "],
  [/[•·▪◦●]/g, ","],
  [/[✓✔☑]/g, ""],
  [/×/g, "x"],
  [/≈/g, "~"],
  [/≤/g, "<="],
  [/≥/g, ">="],
  [/≠/g, "!="],
];

/** Всё, что можно набрать на русской/английской раскладке. */
const ALLOWED = /[\x20-\x7E\n\tА-Яа-яЁё№]/u;

export function humanize(text: string): string {
  let t = text;
  for (const [re, to] of REPLACEMENTS) t = t.replace(re, to);
  return t
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.!?;:])/g, "$1")
    .trim();
}

/** Символы, которых нет на клавиатуре (иероглифы, эмодзи и т.п.), без повторов. */
export function foreignChars(text: string): string[] {
  return [...new Set([...text].filter((c) => !ALLOWED.test(c)))];
}

/** Последняя мера: выкидывает оставшиеся «чужие» символы. */
export function stripForeign(text: string): string {
  return [...text].filter((c) => ALLOWED.test(c)).join("").replace(/[ \t]{2,}/g, " ").trim();
}
