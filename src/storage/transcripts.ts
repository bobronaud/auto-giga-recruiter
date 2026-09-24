import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { redact } from "../util/redact.js";

export interface TranscriptStep {
  ts: string;
  role: "bot" | "me" | "system";
  text: string;
  buttons?: string[];
  action?: string;
  reason?: string;
}

export class Transcript {
  readonly startedAt = new Date();
  readonly steps: TranscriptStep[] = [];
  meta: Record<string, unknown> = {};
  private file: string | undefined;

  constructor(
    private readonly dir: string,
    private readonly enabled: boolean,
    private readonly kind = "transcripts",
  ) {}

  add(step: Omit<TranscriptStep, "ts">): void {
    this.steps.push({ ts: new Date().toISOString(), ...step });
    this.flush();
  }

  /** Пишем на диск после каждого шага, чтобы не потерять данные при падении. */
  flush(): string | undefined {
    if (!this.enabled) return undefined;
    if (!this.file) {
      const d = resolve(this.dir, this.kind);
      mkdirSync(d, { recursive: true, mode: 0o700 });
      const stamp = this.startedAt.toISOString().replace(/[:.]/g, "-");
      this.file = join(d, `${stamp}.json`);
    }
    const body = redact(JSON.stringify({ startedAt: this.startedAt, meta: this.meta, steps: this.steps }, null, 2));
    writeFileSync(this.file, body, { mode: 0o600 });
    return this.file;
  }

  get path(): string | undefined {
    return this.file;
  }
}
