import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { AppConfig } from "../config/schema.js";

export interface Resume {
  file: string;
  path: string;
  content: string;
  isExample: boolean;
}

const EXT = new Set([".md", ".txt", ".markdown"]);
const IGNORED = new Set(["readme.md"]);

export function listResumes(dir: string): Resume[] {
  const full = resolve(dir);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((f) => EXT.has(extname(f).toLowerCase()) && !IGNORED.has(f.toLowerCase()))
    .filter((f) => statSync(join(full, f)).isFile())
    .sort()
    .map((f) => ({
      file: f,
      path: join(full, f),
      content: readFileSync(join(full, f), "utf8").trim(),
      isExample: f.toLowerCase() === "example.md",
    }))
    .filter((r) => r.content.length > 0);
}

/** Регулярка из конфига; поддерживает префикс (?i) для регистронезависимости. */
function compilePattern(pattern: string): RegExp {
  const ci = pattern.startsWith("(?i)");
  return new RegExp(ci ? pattern.slice(4) : pattern, ci ? "i" : "");
}

/** Синонимы стека: как технология может называться в описании вакансии. */
const STACK_ALIASES: Record<string, string[]> = {
  react: ["react", "реакт", "reactjs", "react.js", "next.js", "nextjs", "redux"],
  vue: ["vue", "vuejs", "vue.js", "nuxt", "nuxt.js", "pinia", "vuex"],
  angular: ["angular", "rxjs"],
};
const STOP_TOKENS = new Set(["resume", "cv", "md", "txt", "markdown", "example"]);

/** Ключевые слова резюме по имени файла: resume.vue.md → vue, vue.js, nuxt… */
function resumeKeywords(file: string): string[] {
  const tokens = basename(file, extname(file))
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter((t) => t.length > 1 && !STOP_TOKENS.has(t));
  return [...new Set(tokens.flatMap((t) => STACK_ALIASES[t] ?? [t]))];
}

function countMentions(text: string, word: string): number {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text.match(new RegExp(`(?<![a-zа-яё])${esc}(?![a-zа-яё])`, "gi")) ?? []).length;
}

/**
 * Резюме под стек вакансии: считает упоминания ключевых слов каждого резюме
 * (название вакансии весит больше описания). Ничья или ноль упоминаний — undefined.
 */
export function detectResume(resumes: Resume[], vacancy = "", context = ""): Resume | undefined {
  const scored = resumes
    .filter((r) => !r.isExample)
    .map((r) => ({
      r,
      score: resumeKeywords(r.file).reduce((sum, k) => sum + countMentions(vacancy, k) * 3 + countMentions(context, k), 0),
    }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || best.score === 0 || best.score === second?.score) return undefined;
  return best.r;
}

/**
 * Выбор резюме: явный --resume → правило perVacancy → стек из описания вакансии
 * → resumes.default → резюме с «react» в названии → единственное / первое нешаблонное.
 * Спрашивать пользователя не нужно: undefined только если резюме нет вовсе.
 */
export function pickResume(
  resumes: Resume[],
  cfg: AppConfig["resumes"],
  opts: { explicit?: string; vacancy?: string; context?: string },
): Resume | undefined {
  const byName = (name: string) => {
    const r = resumes.find((x) => x.file === name || basename(x.file, extname(x.file)) === name);
    if (!r) throw new Error(`Резюме «${name}» не найдено в ${cfg.dir}`);
    return r;
  };
  if (opts.explicit) return byName(opts.explicit);
  const text = [opts.vacancy, opts.context].filter(Boolean).join("\n");
  if (text) {
    const rule = cfg.perVacancy.find((r) => compilePattern(r.match).test(text));
    if (rule) return byName(rule.resume);
    const detected = detectResume(resumes, opts.vacancy, opts.context);
    if (detected) return detected;
  }
  if (cfg.default) return byName(cfg.default);
  const real = resumes.filter((r) => !r.isExample);
  const react = real.find((r) => resumeKeywords(r.file).includes("react"));
  return react ?? real[0] ?? resumes[0];
}
