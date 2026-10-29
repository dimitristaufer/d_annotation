import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type LlmUsage = { inputTokens: number; outputTokens: number; lastResetAt: string };

const usagePath = () => path.join(process.cwd(), "data", "llm-usage.json");

async function withUsageLock<T>(operation: (file: string) => Promise<T>): Promise<T> {
  const file = usagePath();
  const lock = file + ".lock";
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let lockHandle;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try { lockHandle = await open(lock, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - (await stat(lock)).mtimeMs > 30_000) await unlink(lock); } catch { /* another request released the stale lock */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!lockHandle) throw new Error("Could not acquire the LLM usage counter lock.");
  try { return await operation(file); }
  finally { await lockHandle.close(); await unlink(lock).catch(() => undefined); }
}

async function readUsage(file: string): Promise<LlmUsage> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<LlmUsage>;
    if (Number.isSafeInteger(value.inputTokens) && Number.isSafeInteger(value.outputTokens) && typeof value.lastResetAt === "string") {
      return { inputTokens: value.inputTokens!, outputTokens: value.outputTokens!, lastResetAt: value.lastResetAt };
    }
  } catch { /* Initialise the counter on first use. */ }
  return { inputTokens: 0, outputTokens: 0, lastResetAt: new Date().toISOString() };
}

async function writeUsage(file: string, value: LlmUsage) {
  const temporary = file + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, file);
}

export async function getLlmUsage() {
  return withUsageLock(async (file) => {
    const value = await readUsage(file);
    try { await readFile(file, "utf8"); } catch { await writeUsage(file, value); }
    return value;
  });
}

export async function addLlmUsage(inputTokens: number, outputTokens: number) {
  if (inputTokens <= 0 && outputTokens <= 0) return;
  await withUsageLock(async (file) => {
    const value = await readUsage(file);
    await writeUsage(file, { ...value, inputTokens: value.inputTokens + inputTokens, outputTokens: value.outputTokens + outputTokens });
  });
}

export async function resetLlmUsage() {
  return withUsageLock(async (file) => {
    const value = { inputTokens: 0, outputTokens: 0, lastResetAt: new Date().toISOString() };
    await writeUsage(file, value);
    return value;
  });
}
