import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { readFileSync } from "node:fs";
import { isGitIgnored } from "../src/config/load.js";
import { configSchema } from "../src/config/schema.js";

describe("config", () => {
  it("пустой конфиг даёт дефолты", () => {
    const c = configSchema.parse({});
    expect(c.answers.maxChars).toBe(800);
    expect(c.behavior.mode).toBe("auto");
    expect(c.llm.model).toBe("claude-opus-5");
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

  it("отклоняет неверный лимит", () => {
    expect(() => configSchema.parse({ answers: { maxChars: -5 } })).toThrow();
  });

  it("logging.dir: data/ игнорируется git, src/ — нет", () => {
    expect(isGitIgnored("./data")).toBe(true);
    expect(isGitIgnored("./logs/browser-profile")).toBe(true);
    expect(isGitIgnored("./src")).toBe(false);
  });
});
