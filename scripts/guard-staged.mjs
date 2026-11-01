#!/usr/bin/env node
// Pre-commit guard: blocks personal data / secrets from being committed,
// then runs secretlint on the staged files.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const { stdout } = await promisify(execFile)(
  "git",
  ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
  { encoding: "utf8" },
);
const staged = stdout.split("\0").filter(Boolean);

const forbidden = [
  { re: /(^|\/)\.env(\..+)?$/, allow: /\.env\.example$/, why: "env-файл с секретами" },
  { re: /(^|\/)config\.ya?ml$/, why: "личный конфиг" },
  { re: /^data\//, why: "сессия / транскрипты" },
  { re: /(^|\/)session\.enc$|\.session(-journal)?$/i, why: "файл сессии Telegram" },
  { re: /(^|\/)(browser-profile|transcripts|recon|claude-workdir|codex-workdir)\//, why: "сессия / транскрипты" },
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
  const status = await new Promise((resolve, reject) => {
    const child = spawn("npx", ["--no-install", "secretlint", ...staged], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (status !== 0) {
    console.error("\n⛔ secretlint нашёл похожие на секреты строки. Коммит заблокирован.\n");
    process.exit(status);
  }
}
