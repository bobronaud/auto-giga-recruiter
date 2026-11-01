import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("../guard-staged.mjs", import.meta.url));

async function check(t, files, { gitStatus = 0, scannerStatus = 0, missingGit = false, missingScanner = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "guard-staged-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const trace = join(dir, "scanner-arguments.json");
  if (!missingGit) {
    await writeFile(join(dir, "git"), `#!${process.execPath}\nrequire("node:fs").writeSync(1, ${JSON.stringify(files.join("\0"))});process.exitCode = ${gitStatus};\n`, { mode: 0o700 });
  }
  if (!missingScanner) {
    await writeFile(join(dir, "npx"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(trace)}, JSON.stringify(process.argv.slice(2)));process.exitCode = ${scannerStatus};\n`, { mode: 0o700 });
  }
  const stderrPath = join(dir, "stderr.txt");
  const stderrFile = await open(stderrPath, "w");
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [guard], {
        cwd: dir,
        env: { ...process.env, PATH: dir },
        stdio: ["ignore", "ignore", stderrFile.fd],
      });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status }));
    });
  } finally {
    await stderrFile.close();
  }
  const stderr = await readFile(stderrPath, "utf8");
  let scanned = null;
  try {
    scanned = JSON.parse(await readFile(trace, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { ...result, stderr, scanned };
}

test("scans every staged path without splitting or trimming filenames", async (t) => {
  const files = ["src/main.ts", "src/file with spaces.ts", "src/file\nwith newline.ts", " trailing-space.txt "];
  const result = await check(t, files);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.scanned, ["--no-install", "secretlint", ...files]);
});

test("does not run the scanner for an empty index", async (t) => {
  const result = await check(t, []);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.scanned, null);
});

test("blocks private paths before the scanner can read them", async (t) => {
  const files = [".env", "config.yaml", "data/session.enc", "resumes/private.md", "nested/browser-profile/cookies", "nested/codex-workdir/request/instructions.md", "nested/claude-workdir/session.json"];
  const result = await check(t, files);
  assert.notEqual(result.status, 0);
  assert.equal(result.scanned, null);
  for (const path of files) assert.ok(result.stderr.includes(path));
});

test("keeps the documented template and resume exceptions", async (t) => {
  const files = [".env.example", "resumes/example.md", "resumes/README.md"];
  const result = await check(t, files);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.scanned, ["--no-install", "secretlint", ...files]);
});

test("fails closed when git fails", async (t) => {
  const result = await check(t, ["src/main.ts"], { gitStatus: 2 });
  assert.notEqual(result.status, 0);
  assert.equal(result.scanned, null);
});

test("fails closed when git cannot start", async (t) => {
  const result = await check(t, [], { missingGit: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.scanned, null);
});

test("rejects commits when secretlint fails", async (t) => {
  const result = await check(t, ["src/main.ts"], { scannerStatus: 1 });
  assert.notEqual(result.status, 0);
  assert.notEqual(result.scanned, null);
});

test("fails closed when the scanner cannot start", async (t) => {
  const result = await check(t, ["src/main.ts"], { missingScanner: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.scanned, null);
});
