import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ARCHIVE_LIMIT = 24 * 14;
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
type BackupInput = { profiles: unknown[]; annotations: unknown[] };

export async function GET() {
  const backupDirectory = path.join(process.cwd(), "data", "backups");
  try {
    const archives = (await readdir(backupDirectory)).filter((name) => /^annotations-\d{4}-\d{2}-\d{2}T\d{2}\.json$/.test(name)).sort().reverse();
    for (const name of archives) {
      try {
        const backup = JSON.parse(await readFile(path.join(backupDirectory, name), "utf8")) as { capturedAt?: unknown };
        if (typeof backup.capturedAt === "string" && Number.isFinite(Date.parse(backup.capturedAt))) {
          return NextResponse.json({ capturedAt: backup.capturedAt }, { headers: { "cache-control": "no-store" } });
        }
      } catch { /* Skip a damaged archive and try the next recent one. */ }
    }
    try {
      const latest = JSON.parse(await readFile(path.join(backupDirectory, "latest.json"), "utf8")) as { capturedAt?: unknown };
      if (typeof latest.capturedAt === "string" && Number.isFinite(Date.parse(latest.capturedAt))) {
        return NextResponse.json({ capturedAt: latest.capturedAt }, { headers: { "cache-control": "no-store" } });
      }
    } catch { /* No previous backup exists yet. */ }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return NextResponse.json({ error: "Could not read backup status." }, { status: 500 });
  }
  return NextResponse.json({ capturedAt: null }, { headers: { "cache-control": "no-store" } });
}

async function writeAtomic(filePath: string, contents: string) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

export async function POST(request: NextRequest) {
  let input: BackupInput;
  try { input = await request.json() as BackupInput; }
  catch { return NextResponse.json({ error: "Invalid backup data." }, { status: 400 }); }
  if (!Array.isArray(input?.profiles) || !Array.isArray(input?.annotations)) {
    return NextResponse.json({ error: "Backup data must include profiles and annotations." }, { status: 400 });
  }
  const capturedAt = new Date();
  const snapshot = { schemaVersion: 1, capturedAt: capturedAt.toISOString(), profiles: input.profiles, annotations: input.annotations };
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, "utf8") > MAX_BACKUP_BYTES) {
    return NextResponse.json({ error: "Backup is larger than the local backup limit." }, { status: 413 });
  }
  const backupDirectory = path.join(process.cwd(), "data", "backups");
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const latestPath = path.join(backupDirectory, "latest.json");
  const digest = createHash("sha256").update(JSON.stringify({ profiles: snapshot.profiles, annotations: snapshot.annotations })).digest("hex");
  let latestDigest = "";
  try {
    const previous = JSON.parse(await readFile(latestPath, "utf8")) as { digest?: string };
    latestDigest = previous.digest ?? "";
  } catch { /* the first backup has no previous digest */ }
  if (digest !== latestDigest) {
    await writeAtomic(latestPath, JSON.stringify({ ...snapshot, digest }));
  }
  const archiveName = `annotations-${capturedAt.toISOString().slice(0, 13).replace(/:/g, "-")}.json`;
  await writeAtomic(path.join(backupDirectory, archiveName), JSON.stringify({ ...snapshot, digest }));
  const archives = (await readdir(backupDirectory)).filter((name) => /^annotations-\d{4}-\d{2}-\d{2}T\d{2}\.json$/.test(name)).sort().reverse();
  await Promise.all(archives.slice(ARCHIVE_LIMIT).map((name) => unlink(path.join(backupDirectory, name)).catch(() => undefined)));
  return NextResponse.json({ saved: true, capturedAt: snapshot.capturedAt, annotations: snapshot.annotations.length });
}
