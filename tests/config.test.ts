import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { readFileSync } from "node:fs";
import { isGitIgnored } from "../src/config/load.js";
import { configSchema, envSchema, legacyLlmWarnings } from "../src/config/schema.js";

describe("config", () => {
  it("пустой конфиг даёт дефолты", () => {
    const c = configSchema.parse({});
    expect(c.answers.maxChars).toBe(800);
    expect(c.behavior.mode).toBe("auto");
    expect(c.llm.provider).toBe("codex");
    expect(c.llm.model).toBeUndefined();
  });

  it("config.example.yaml валиден", () => {
    const raw = YAML.parse(readFileSync("config.example.yaml", "utf8"));
    expect(() => configSchema.parse(raw)).not.toThrow();
  });

  it("частичный конфиг дополняется дефолтами", () => {
    const c = configSchema.parse({ answers: { maxChars: 300 } });
    expect(c.answers.maxChars).toBe(300);
    expect(c.answers.tone).toBe("professional");
  });

  it.each(["auto", "claude-code", "api"])("загружает старый провайдер %s как Codex", (provider) => {
    const raw = { llm: { provider, model: "claude-opus-5", maxTokens: 8000, fallbacks: true } };
    expect(configSchema.parse(raw).llm).toEqual({ provider: "codex", model: undefined, effort: "medium" });
    expect(legacyLlmWarnings(raw)).toHaveLength(3);
  });

  it("сохраняет явную модель Codex и не предупреждает для нового конфига", () => {
    const raw = { llm: { provider: "codex", model: "test-model", effort: "high" } };
    expect(configSchema.parse(raw).llm).toEqual(raw.llm);
    expect(legacyLlmWarnings(raw)).toEqual([]);
    expect(legacyLlmWarnings({})).toEqual([]);
    expect(legacyLlmWarnings(null)).toEqual([]);
  });

  it("игнорирует старый ключ Anthropic и отвергает неизвестный провайдер", () => {
    expect(envSchema.parse({ ANTHROPIC_API_KEY: "synthetic-key" })).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(() => configSchema.parse({ llm: { provider: "unknown" } })).toThrow();
  });

  it("отклоняет неверный лимит", () => {
    expect(() => configSchema.parse({ answers: { maxChars: -5 } })).toThrow();
  });

  it("logging.dir: data/ игнорируется git, src/ — нет", () => {
    expect(isGitIgnored("./data")).toBe(true);
    expect(isGitIgnored("./logs/browser-profile")).toBe(true);
    expect(isGitIgnored("./logs/codex-workdir")).toBe(true);
    expect(isGitIgnored("./logs/claude-workdir")).toBe(true);
    expect(isGitIgnored("./src")).toBe(false);
  });
});
