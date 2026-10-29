import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 8;
const filePath = () => path.join(process.cwd(), "data", "login-attempts.json");
const keyFor = (ip: string) => createHash("sha256").update(ip).digest("hex");

async function withLockedAttempts<T>(update: (attempts: Record<string, number[]>, now: number) => T) {
  const file = filePath();
  const lock = `${file}.lock`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try { handle = await open(lock, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - (await stat(lock)).mtimeMs > 30_000) await unlink(lock); } catch { /* another request released the stale lock */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!handle) throw new Error("Could not acquire the login rate-limit lock.");
  try {
    const now = Date.now();
    let attempts: Record<string, number[]> = {};
    try {
      const saved = JSON.parse(await readFile(file, "utf8")) as { attempts?: unknown };
      if (saved.attempts && typeof saved.attempts === "object" && !Array.isArray(saved.attempts)) {
        attempts = Object.fromEntries(Object.entries(saved.attempts).filter((entry): entry is [string, number[]] => Array.isArray(entry[1])).map(([key, times]) => [key, times.filter((time): time is number => typeof time === "number" && Number.isFinite(time) && now - time < WINDOW_MS)]).filter(([, times]) => times.length > 0));
      }
    } catch { /* first request creates the attempt store */ }
    const result = update(attempts, now);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ attempts }), { mode: 0o600 });
    await rename(temporary, file);
    return result;
  } finally {
    await handle.close();
    await unlink(lock).catch(() => undefined);
  }
}

export async function getLoginRetryAfter(ip: string) {
  return withLockedAttempts((attempts, now) => {
    const times = attempts[keyFor(ip)] ?? [];
    if (times.length < MAX_FAILURES) return 0;
    return Math.max(1, Math.ceil((times[0] + WINDOW_MS - now) / 1000));
  });
}

export async function recordLoginFailure(ip: string) {
  await withLockedAttempts((attempts, now) => {
    const key = keyFor(ip);
    attempts[key] = [...(attempts[key] ?? []), now].slice(-MAX_FAILURES);
  });
}

export async function clearLoginFailures(ip: string) {
  await withLockedAttempts((attempts) => { delete attempts[keyFor(ip)]; });
}
