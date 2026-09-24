#!/usr/bin/env node
// Pre-commit guard: blocks personal data / secrets from being committed,
// then runs secretlint on the staged files.
import { execFileSync, spawnSync } from "node:child_process";

const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
  encoding: "utf8",
})
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean);

const forbidden = [
  { re: /(^|\/)\.env(\..+)?$/, allow: /\.env\.example$/, why: "env-файл с секретами" },
  { re: /(^|\/)config\.ya?ml$/, why: "личный конфиг" },
  { re: /^data\//, why: "сессия / транскрипты" },
  { re: /\.session$|(^|\/)session[^/]*$/i, why: "файл сессии Telegram" },
  { re: /^resumes\//, allow: /^resumes\/(example\.md|README\.md)$/, why: "личное резюме" },
];

const violations = staged.flatMap((file) =>
  forbidden
    .filter((rule) => rule.re.test(file) && !(rule.allow && rule.allow.test(file)))
    .map((rule) => `  ✗ ${file} — ${rule.why}`),
);

if (violations.length) {
  console.error("\n⛔ Коммит заблокирован: в индексе есть приватные файлы:\n" + violations.join("\n"));
  console.error("\nУбери их: git restore --staged <file>\n");
  process.exit(1);
}

if (staged.length) {
  const res = spawnSync("npx", ["--no-install", "secretlint", ...staged], { stdio: "inherit" });
  if (res.status !== 0) {
    console.error("\n⛔ secretlint нашёл похожие на секреты строки. Коммит заблокирован.\n");
    process.exit(res.status ?? 1);
  }
}
