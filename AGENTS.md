# Контекст проекта auto-giga-recruiter

Этот файл применяется только к данному репозиторию и его подкаталогам.

## Git

Создавай локальные коммиты самостоятельно по мере завершения логических
изменений. Выполняй push только по явному запросу пользователя. Не отключай
pre-commit-проверки ради создания коммита.

Проверка pre-commit-скрипта: `node scripts/tests/guard-staged.mjs`.

## Сведения, перенесённые из Claude Code

Ниже сохранён полный `autoMode.environment` из пользовательского
`~/.claude/settings.json`. Дата переноса: 2026-10-31.

Это сведения и допущения прежней среды, а не проверка текущего состояния
и не разрешение на внешние действия. `None configured` означает отсутствие
сведений в исходной настройке. Утверждение об открытом интернете и отсутствии
изоляции относится к прежней среде Claude Code: текущие ограничения Codex
определяются фактической средой и профилем песочницы. Сведения о ветках,
видимости репозитория, шифровании сессии и инфраструктуре при необходимости
проверяй без чтения секретов и закрытых пользовательских данных.

Публичные paste/gist-сервисы не считаются доверенными получателями данных.
Не раскрывай содержимое `.env`, персональных резюме и сессий Telegram.

### Org-wide
**Organization**: None configured
**Cloud provider(s)**: None configured
**Repository visibility**: not queryable here — assume private (no evidence of public visibility; repo name/remote give no indication otherwise)
**Internal sharing / snippet hosting**: None configured — treat public paste/gist services as outside the trust boundary
**Secrets management**: None configured — repo uses local .env (gitignored) with ANTHROPIC_API_KEY, TG_API_ID, TG_API_HASH, SESSION_PASSPHRASE; secretlint configured in package.json
**Default / protected branches**: not queryable here (gh visibility/rulesets/branch checks returned not queryable) — treat as unknown, do not assume unprotected
**CI/CD deploy targets**: None configured
**Network posture**: None configured
**Host containment**: None configured — assume Claude Code runs on an ordinary developer machine with open internet
**Source control**: The trusted repo (github.com:bobronaud/auto-giga-recruiter.git) and its remote only — no additional orgs configured
**Trusted internal domains**: None configured
**Trusted cloud buckets**: None configured
**Key internal services**: None configured
**Internal package registry**: None configured
**Sensitive data locations & audiences**: .env (gitignored, holds ANTHROPIC_API_KEY/TG_API_ID/TG_API_HASH/SESSION_PASSPHRASE), resumes/ directory (personal resume data used for AI interview answers), data/session.enc (Telegram session file, AES-256-GCM encrypted unless SESSION_PASSPHRASE unset, in which case stored plaintext) — share only with audiences cleared for this project's own use
**Data retention / declassification**: None configured
**Sensitive remote targets**: any namespace, host, or container whose name carries 'prod' or 'production' as a whole word or name segment
**Protected deployment namespaces / environments**: None configured — fall back to the Sensitive remote targets heuristic
**Protected IaC scopes**: IAM, RBAC, networking, quota, and node-pool resources; anything whose name or tag carries 'prod' or 'production' as a whole word or name segment
### User-specific
**Primary use of Claude Code**: software development (personal/hobby project — Telegram AI-interview automation CLI)
**Trusted repo**: /home/bobro/projects/auto-giga-recruiter (remote github.com:bobronaud/auto-giga-recruiter.git), visibility unconfirmed — treat as private pending confirmation
**Org-specific CLiS**: None configured
**Org-specific CLIs**: None configured
