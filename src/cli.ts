#!/usr/bin/env node
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { Command, type Option } from "commander";
import pc from "picocolors";
import { Api } from "telegram";
import { ConfigError, loadConfig, loadEnv } from "./config/load.js";
import type { AppConfig, AppEnv } from "./config/schema.js";
import { SimulatedChannel } from "./interview/channel.js";
import { BATCH, BatchState, navigateToVacancy, nextBatchVacancy, type NavigationResult } from "./interview/navigate.js";
import { runRecon } from "./interview/recon.js";
import { runInterview, type RunResult } from "./interview/runner.js";
import { createBrain, resolveProvider } from "./llm/brain.js";
import { countTokens } from "./llm/claude.js";
import { buildSystemPrompt } from "./llm/prompts.js";
import { listResumes, pickResume, type Resume } from "./resumes/loader.js";
import { Transcript } from "./storage/transcripts.js";
import { connect, login } from "./telegram/client.js";
import { openBotChat, sessionStore, webOptions, type ChatSession } from "./telegram/open-chat.js";
import { hasProfile, removeProfile, TelegramWeb } from "./telegram/web/browser.js";
import { askConfirm, askSecret, askText, UserCancelled } from "./ui/ask.js";
import { banner, formatDuration } from "./ui/render.js";
import { maskPhone, redactError } from "./util/redact.js";

const program = new Command()
  .name("giga")
  .description("Автопрохождение ИИ-интервью в ГигаРекрутере (Telegram) с помощью Claude")
  .option("-c, --config <path>", "путь к конфигу", "config.yaml")
  .helpOption("-h, --help", "показать справку")
  .helpCommand(false);

// ---------- инфраструктура ----------

function interruptSignal(): AbortSignal {
  const ctrl = new AbortController();
  let hits = 0;
  process.on("SIGINT", () => {
    hits++;
    if (hits === 1) {
      ctrl.abort();
      console.log(pc.yellow("\n⏹  Завершаю аккуратно… (ещё раз Ctrl+C — выйти сразу)"));
    } else {
      process.exit(130);
    }
  });
  return ctrl.signal;
}

type LoadedConfig = ReturnType<typeof loadConfig>;

function cfg(): LoadedConfig {
  const c = loadConfig(program.opts().config);
  if (c.__source === "defaults") p.log.warn(`Конфиг не найден, используются значения по умолчанию. Создай его: ${pc.bold("npm start -- init")}`);
  return c;
}

/** Подключается выбранным драйвером, открывает чат с ботом и гарантированно закрывает всё в конце. */
async function withChat<T>(
  fn: (chat: ChatSession["chat"], c: AppConfig) => Promise<T>,
  opts: { requireAnthropic?: boolean; headless?: boolean } = {},
): Promise<T> {
  const c = cfg();
  const env = loadEnv({ requireAnthropic: opts.requireAnthropic, requireTelegramApi: c.telegram.driver === "mtproto" });
  const s = p.spinner();
  s.start(c.telegram.driver === "web" ? "Запускаю Telegram Web…" : "Подключаюсь к Telegram…");
  const session = await openBotChat(c, env, { headless: opts.headless }).catch((err) => {
    s.error("Не удалось открыть чат с ботом");
    throw err;
  });
  s.stop(`Чат открыт: ${pc.bold(session.chat.title)}${session.me ? pc.dim(` · вошёл как ${session.me}`) : ""}`);
  try {
    return await fn(session.chat, c);
  } finally {
    await session.close();
  }
}

/** Перерисовывает QR-код на месте, а не печатает новый под старым. */
function qrPrinter() {
  let lines = 0;
  return (ascii: string) => {
    if (lines) process.stdout.write(`\x1b[${lines}A\x1b[0J`);
    const text = [
      pc.bold("Отсканируй QR-код в приложении Telegram на телефоне:"),
      pc.dim("Настройки → Устройства → Подключить устройство"),
      ascii,
      pc.dim("Код обновляется автоматически. Ctrl+C — отмена."),
    ].join("\n");
    process.stdout.write(text + "\n");
    lines = text.split("\n").length;
  };
}

function chooseResume(c: AppConfig, explicit?: string, vacancy?: string, context?: string): Resume {
  const resumes = listResumes(c.resumes.dir);
  const picked = pickResume(resumes, c.resumes, { explicit, vacancy, context });
  if (!picked) throw new ConfigError(`В ${c.resumes.dir} нет резюме (.md/.txt). Положи туда хотя бы одно.`);
  return picked;
}

function brainFor(c: AppConfig, env: AppEnv, resume: Resume, vacancy?: string) {
  const system = buildSystemPrompt({ resume: resume.content, resumeFile: resume.file, vacancy, answers: c.answers });
  return createBrain(c, env, system, join(c.logging.dir, "claude-workdir"));
}

function providerLabel(c: AppConfig, env: AppEnv): string {
  return resolveProvider(c, env) === "api" ? `API (${c.llm.model})` : `подписка Claude через Claude Code (${c.llm.model})`;
}

function summary(res: RunResult, transcript: Transcript) {
  const u = res.usage;
  p.note(
    [
      `${pc.bold("Итог:")} ${res.reason}`,
      `Ответов: ${res.replies} · нажатий: ${res.clicks} · длительность: ${formatDuration(res.durationMs)}`,
      `Claude: ${u.requests} запросов · вход ${u.input} (+кэш чтение ${u.cacheRead}, запись ${u.cacheWrite}) · выход ${u.output} токенов` +
        (u.costUsd ? pc.dim(` · ≈$${u.costUsd.toFixed(3)} по прайсу API${u.costUsd && res.provider === "claude-code" ? " (по подписке не списывается)" : ""}`) : ""),
      transcript.path ? `Транскрипт: ${pc.dim(transcript.path)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    "Интервью",
  );
}

// ---------- команды ----------

program
  .command("init")
  .description("создать config.yaml и .env из примеров")
  .action(() => {
    for (const [from, to] of [
      ["config.example.yaml", "config.yaml"],
      [".env.example", ".env"],
    ] as const) {
      if (existsSync(to)) p.log.info(`${to} уже существует — пропускаю`);
      else {
        copyFileSync(from, to);
        p.log.success(`Создан ${to}`);
      }
    }
    p.outro(`Заполни ${pc.bold(".env")}, положи резюме в ${pc.bold("resumes/")} и запусти ${pc.bold("npm run login")}`);
  });

program
  .command("login")
  .description("войти в Telegram и сохранить сессию")
  .option("--headful", "показать окно браузера (web-драйвер)")
  .action(async (o: { headful?: boolean }) => {
    const c = cfg();
    if (c.telegram.driver === "web") return loginWeb(c, Boolean(o.headful));
    const env = loadEnv({ requireTelegramApi: true });
    const st = sessionStore(c, env);
    if (st.exists() && !(await askConfirm("Сессия уже есть. Перелогиниться?", false))) return;

    p.log.info("Телефон и пароль 2FA никуда не сохраняются — только зашифрованная (при SESSION_PASSPHRASE) сессия.");
    const client = await login(env, st, {
      phone: () => askText("Номер телефона", { placeholder: "+79991234567", required: true }),
      code: (viaApp) => askText(viaApp ? "Код из приложения Telegram" : "Код из SMS", { required: true }),
      password: (hint) => askSecret(`Облачный пароль (2FA)${hint ? ` — подсказка: ${hint}` : ""}`),
      onError: (err) => p.log.error(redactError(err)),
    });
    const me = await client.getMe();
    await client.destroy().catch(() => undefined);
    p.log.success(`Вошёл как ${pc.bold([me.firstName, me.lastName].filter(Boolean).join(" "))} ${pc.dim(me.phone ? maskPhone(me.phone) : "")}`);
    p.outro(
      `Сессия сохранена в ${pc.dim(st.path)} ${st.isEncrypted() ? pc.green("(зашифрована)") : pc.yellow("(без шифрования — задай SESSION_PASSPHRASE)")}`,
    );
  });

async function loginWeb(c: AppConfig, headful: boolean) {
  const signal = interruptSignal();
  const s = p.spinner();
  s.start("Запускаю Telegram Web…");
  const web = await TelegramWeb.launch(webOptions(c, headful ? false : undefined));
  try {
    const state = await web.detectState();
    s.stop("Telegram Web загружен");
    if (state === "ready") {
      p.outro(`Уже выполнен вход. Чтобы войти заново: ${pc.bold("npm run logout")}, затем ${pc.bold("npm run login")}`);
      return;
    }
    const showQr = qrPrinter();
    await web.loginWithQr({
      showQr,
      askPassword: (hint, retry) =>
        askSecret(`${retry ? pc.red("Неверный пароль. ") : ""}Облачный пароль (2FA)${hint && hint !== "Password" ? ` — подсказка: ${hint}` : ""}`),
      info: (msg) => p.log.info(msg),
      signal,
    });
    // Даём Telegram Web сохранить авторизацию в профиль
    await web.page.waitForTimeout(3000);
    p.log.success("Вход выполнен");
    p.outro(
      `Авторизация сохранена в профиле браузера ${pc.dim(webOptions(c).profileDir)} (в .gitignore). Дальше: ${pc.bold("npm run recon -- --interactive")}`,
    );
  } finally {
    await web.close();
  }
}

program
  .command("logout")
  .description("выйти из Telegram и удалить сессию с диска")
  .action(async () => {
    const c = cfg();
    if (c.telegram.driver === "web") {
      if (!hasProfile(c.logging.dir)) return p.outro("Сессии нет");
      if (!(await askConfirm("Удалить профиль браузера с авторизацией Telegram Web?"))) return;
      removeProfile(c.logging.dir);
      p.log.success("Профиль браузера удалён");
      p.outro(
        `Для полной уверенности заверши сеанс «Telegram Web» в приложении: ${pc.bold("Настройки → Устройства")}`,
      );
      return;
    }
    const env = loadEnv({ requireTelegramApi: true });
    const st = sessionStore(c, env);
    if (!st.exists()) return p.outro("Сессии нет");
    try {
      const client = await connect(env, st);
      await client.invoke(new Api.auth.LogOut());
      await client.destroy().catch(() => undefined);
    } catch (err) {
      p.log.warn(`Не удалось завершить сессию на сервере: ${redactError(err)}`);
    }
    st.remove();
    p.outro("Сессия удалена");
  });

program
  .command("status")
  .description("проверить конфиг, сессию и резюме")
  .action(async () => {
    const c = cfg();
    const env = loadEnv();
    p.log.info(`Конфиг: ${c.__source}`);
    p.log.info(`Драйвер: ${c.telegram.driver} · бот: @${c.bot.username} · модель: ${c.llm.model} · лимит ответа: ${c.answers.maxChars} симв. · режим: ${c.behavior.mode}`);
    p.log.info(`Резюме: ${listResumes(c.resumes.dir).map((r) => r.file).join(", ") || pc.red("нет")}`);
    p.log.info(`Claude: ${providerLabel(c, env)}`);
    await withChat(async (chat) => {
      p.log.success(`Бот найден: ${chat.title}`);
    });
  });

program
  .command("resumes")
  .description("показать резюме и их размер в токенах")
  .action(async () => {
    const c = cfg();
    const env = loadEnv();
    const list = listResumes(c.resumes.dir);
    if (!list.length) return p.log.warn(`В ${c.resumes.dir} нет резюме`);
    for (const r of list) {
      let tokens = "";
      if (env.ANTHROPIC_API_KEY) {
        tokens = ` · ${await countTokens(env.ANTHROPIC_API_KEY, c.llm.model, r.content).catch(() => "?")} токенов`;
      }
      const isDefault = c.resumes.default === r.file ? pc.green(" (default)") : "";
      p.log.info(`${pc.bold(r.file)}${isDefault}${r.isExample ? pc.yellow(" [шаблон]") : ""} — ${r.content.length} симв.${tokens}`);
    }
  });

program
  .command("recon")
  .description("разведка: логировать сообщения и кнопки бота, чтобы изучить его формат")
  .option("-i, --interactive", "управлять ботом вручную (кнопки/текст)")
  .option("--history <n>", "показать последние N сообщений чата", "10")
  .option("--no-start", "не отправлять /start")
  .option("--headful", "показать окно браузера (web-драйвер)")
  .action(async (o: { interactive?: boolean; history: string; start: boolean; headful?: boolean }) => {
    const signal = interruptSignal();
    const path = await withChat(
      (chat, c) => runRecon(chat, c, { interactive: Boolean(o.interactive), history: Number(o.history), start: o.start, signal }),
      { headless: o.headful ? false : undefined },
    );
    p.outro(path ? `Дамп сохранён: ${pc.dim(path)}` : "Готово");
  });

program
  .command("interview")
  .description("пройти интервью")
  .option("-v, --vacancy <text|index>", "выбрать вакансию автоматически (подстрока названия или индекс кнопки)")
  .option("-r, --resume <file>", "файл резюме из resumes/ (по умолчанию выбирается по стеку вакансии)")
  .option("-a, --all", "пройти все доступные интервью подряд")
  .option("--confirm", "подтверждать каждый ответ вручную")
  .option("--auto", "полностью автономно (перекрывает behavior.mode)")
  .option("--dry-run", "офлайн-симуляция: интервьюера играешь ты, в Telegram ничего не уходит")
  .option("--no-start", "не отправлять /start (продолжить с текущего места чата)")
  .option("--headful", "показать окно браузера (web-драйвер)")
  .action(async (o: { vacancy?: string; resume?: string; all?: boolean; confirm?: boolean; auto?: boolean; dryRun?: boolean; start: boolean; headful?: boolean }) => {
    const c = cfg();
    const env = loadEnv();
    const mode = o.auto ? "auto" : o.confirm ? "confirm" : c.behavior.mode;
    const signal = interruptSignal();

    if (o.dryRun) {
      const transcript = new Transcript(c.logging.dir, c.logging.saveTranscripts);
      p.log.info("Режим симуляции: вводи сообщения интервьюера, ИИ будет отвечать. Пустая строка — конец.");
      const vacancy = o.vacancy ?? ((await askText("Вакансия (можно пусто)")) || undefined);
      const resume = chooseResume(c, o.resume, vacancy);
      p.log.step(`Резюме: ${pc.bold(resume.file)} · режим: ${mode} · ${providerLabel(c, env)}`);
      transcript.meta = { dryRun: true, vacancy, resume: resume.file, model: c.llm.model };
      const res = await runInterview({
        channel: new SimulatedChannel(),
        cfg: { ...c, behavior: { ...c.behavior, maxTurns: 1000 } },
        brain: await brainFor(c, env, resume, vacancy),
        vacancy,
        mode,
        transcript,
        signal,
        noTyping: true,
      });
      return summary(res, transcript);
    }

    await withChat(
      async (chat, c2) => {
        const runOne = async (nav: NavigationResult): Promise<RunResult> => {
          const resume = chooseResume(c2, o.resume, nav.vacancy, nav.context);
          p.log.step(`Вакансия: ${pc.bold(nav.vacancy ?? "—")} · резюме: ${pc.bold(resume.file)} · режим: ${pc.bold(mode)} · ${providerLabel(c2, env)}`);
          const transcript = new Transcript(c2.logging.dir, c2.logging.saveTranscripts);
          transcript.meta = { vacancy: nav.vacancy, resume: resume.file, model: c2.llm.model, bot: c2.bot.username };
          const res = await runInterview({
            channel: chat,
            cfg: c2,
            brain: await brainFor(c2, env, resume, nav.vacancy),
            vacancy: nav.vacancy,
            mode,
            initialMessages: nav.messages,
            initialNotes: nav.notes,
            transcript,
            signal,
          });
          summary(res, transcript);
          return res;
        };

        // После интервью возвращаемся в меню со списком вакансий, пока пользователь не выберет «Выйти»
        let skipStart = !o.start;
        let batch = Boolean(o.all);
        let vacancy = o.vacancy;
        while (!signal.aborted) {
          if (batch) {
            await runBatch(chat, c2, signal, runOne);
            batch = false;
            skipStart = true;
            continue;
          }
          const nav = await navigateToVacancy(chat, c2, { vacancy, skipStart, signal });
          vacancy = undefined;
          skipStart = true;
          if (nav === BATCH) batch = true;
          else if (nav) await runOne(nav);
          else break;
        }
      },
      { headless: o.headful ? false : undefined },
    );
    p.outro("Готово");
  });

/** Проходит по очереди все вакансии из списка бота. */
async function runBatch(
  chat: ChatSession["chat"],
  c: AppConfig,
  signal: AbortSignal,
  runOne: (nav: NavigationResult) => Promise<RunResult>,
) {
  const state = new BatchState();
  const results: Array<{ vacancy: string; reason: string }> = [];
  p.log.step(pc.bold("Пакетный режим: прохожу все доступные интервью по очереди"));
  while (!signal.aborted) {
    const nav = await nextBatchVacancy(chat, c, state, signal);
    if (!nav) break;
    const res = await runOne(nav);
    results.push({ vacancy: nav.vacancy ?? "—", reason: res.reason });
  }
  p.note(
    results.length ? results.map((r, i) => `${i + 1}. ${pc.bold(r.vacancy)}\n   ${pc.dim(r.reason)}`).join("\n") : "Новых интервью не нашлось",
    `Пакет: пройдено ${results.length}`,
  );
}

/** Команда запуска: `npm run <name>`, если есть такой скрипт, иначе `npm start -- <name>`. */
function runHint(name: string): string {
  return ["login", "recon", "interview", "resumes", "logout", "help"].includes(name) ? `npm run ${name}` : `npm start -- ${name}`;
}

function printCommandHelp(cmd: Command) {
  const byDefault = (o: Option) =>
    o.defaultValue !== undefined && typeof o.defaultValue !== "boolean" ? pc.dim(` (по умолчанию: ${o.defaultValue})`) : "";
  const options = cmd.options.filter((o) => !o.hidden && o.long !== "--help");
  const pad = Math.max(0, ...options.map((o) => o.flags.length));
  const lines = [
    `${pc.bold(pc.green(cmd.name()))} ${pc.dim("—")} ${cmd.description()}`,
    `  ${pc.dim("запуск:")} ${pc.cyan(runHint(cmd.name()))}${options.length ? pc.cyan(" -- [опции]") : ""}`,
    ...options.map((o) => `  ${pc.yellow(o.flags.padEnd(pad))}  ${o.description}${byDefault(o)}`),
  ];
  console.log(lines.join("\n"));
}

program
  .command("help [command]")
  .description("показать все команды с подсказками (или подробно одну)")
  .action((name?: string) => {
    const commands = program.commands;
    if (name) {
      const cmd = commands.find((c) => c.name() === name || c.aliases().includes(name));
      if (!cmd) throw new ConfigError(`Нет команды «${name}». Доступные: ${commands.map((c) => c.name()).join(", ")}`);
      return printCommandHelp(cmd);
    }
    console.log(`${program.description()}\n`);
    for (const cmd of commands) {
      printCommandHelp(cmd);
      console.log();
    }
    console.log(`${pc.bold("Общие опции:")} ${pc.yellow("-c, --config <path>")} путь к конфигу ${pc.dim("(по умолчанию: config.yaml)")}`);
    console.log(pc.dim(`Подробно об одной команде: ${runHint("help")} -- <команда>`));
  });

// ---------- запуск ----------

banner();
program
  .parseAsync()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err instanceof UserCancelled) p.cancel("Отменено");
    else if (err instanceof ConfigError) p.log.error(err.message);
    else p.log.error(pc.red(redactError(err)));
    process.exit(1);
  });
