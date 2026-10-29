import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type ConversationList = { id: string; name: string; conversationIds: string[]; createdAt: string; updatedAt: string };
const directory = () => path.join(process.cwd(), "data");
const filePath = () => path.join(directory(), "conversation-lists.json");
const lockPath = () => path.join(directory(), "conversation-lists.lock");

async function readLists(): Promise<ConversationList[]> {
  try {
    const value = JSON.parse(await readFile(filePath(), "utf8")) as { lists?: unknown };
    return Array.isArray(value.lists) ? value.lists as ConversationList[] : [];
  } catch { return []; }
}

function cleanConversationIds(value: unknown) {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean);
  if (ids.length > 5000 || ids.some((id) => id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id))) return null;
  return [...new Set(ids)];
}

async function mutate<T>(operation: (lists: ConversationList[]) => { lists: ConversationList[]; result: T }) {
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  let lock;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try { lock = await open(lockPath(), "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - (await stat(lockPath())).mtimeMs > 30_000) await unlink(lockPath()); } catch { /* another write released it */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  if (!lock) throw new Error("Could not lock the shared conversation lists.");
  try {
    const { lists, result } = operation(await readLists());
    const temporary = `${filePath()}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, lists }), { mode: 0o600 });
    await rename(temporary, filePath());
    return result;
  } finally { await lock.close(); await unlink(lockPath()).catch(() => undefined); }
}

export async function GET() { return NextResponse.json({ lists: await readLists() }, { headers: { "cache-control": "no-store" } }); }

export async function POST(request: NextRequest) {
  let input: { name?: unknown; conversationIds?: unknown };
  try { input = await request.json() as typeof input; } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 100) : "";
  const conversationIds = cleanConversationIds(input.conversationIds ?? []);
  if (!name) return NextResponse.json({ error: "Enter a name for this list." }, { status: 400 });
  if (!conversationIds) return NextResponse.json({ error: "Conversation IDs must be plain IDs, with no more than 5,000 unique entries." }, { status: 400 });
  const now = new Date().toISOString();
  const list = { id: randomUUID(), name, conversationIds, createdAt: now, updatedAt: now };
  await mutate((lists) => ({ lists: [...lists, list], result: list }));
  return NextResponse.json({ list }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  let input: { id?: unknown; name?: unknown; conversationIds?: unknown; addConversationIds?: unknown; removeConversationIds?: unknown };
  try { input = await request.json() as typeof input; } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  if (typeof input.id !== "string") return NextResponse.json({ error: "A list ID is required." }, { status: 400 });
  const replacement = input.conversationIds === undefined ? undefined : cleanConversationIds(input.conversationIds);
  const adds = input.addConversationIds === undefined ? [] : cleanConversationIds(input.addConversationIds);
  const removes = input.removeConversationIds === undefined ? [] : cleanConversationIds(input.removeConversationIds);
  if ((input.conversationIds !== undefined && !replacement) || !adds || !removes) return NextResponse.json({ error: "Conversation IDs must be plain IDs, with no more than 5,000 unique entries." }, { status: 400 });
  if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim())) return NextResponse.json({ error: "List name cannot be empty." }, { status: 400 });
  const list = await mutate((lists) => {
    const index = lists.findIndex((item) => item.id === input.id);
    if (index < 0) return { lists, result: null };
    const current = lists[index];
    const excluded = new Set(removes);
    const conversationIds = replacement ?? [...new Set([...current.conversationIds.filter((id) => !excluded.has(id)), ...adds])].slice(0, 5000);
    const updated = { ...current, name: typeof input.name === "string" ? input.name.trim().slice(0, 100) : current.name, conversationIds, updatedAt: new Date().toISOString() };
    lists[index] = updated;
    return { lists, result: updated };
  });
  return list ? NextResponse.json({ list }) : NextResponse.json({ error: "List not found." }, { status: 404 });
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "A list ID is required." }, { status: 400 });
  const deleted = await mutate((lists) => ({ lists: lists.filter((list) => list.id !== id), result: lists.some((list) => list.id === id) }));
  return deleted ? NextResponse.json({ deleted: true }) : NextResponse.json({ error: "List not found." }, { status: 404 });
}
