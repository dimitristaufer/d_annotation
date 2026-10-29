import { spawn } from "node:child_process";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function resolveConversationIds(conversationIds: string[], signal: AbortSignal, summaryOnly = false, includeText = false) {
  return new Promise<{ records?: Array<{ recordId: string; conversationId: string; turnIndex: number; messageText?: string }>; matches?: Array<{ conversationId: string; requesterMessages: number; indexedConversations: number }>; missingConversationIds: string[] }>((resolve, reject) => {
    const child = spawn(process.env.PYTHON || "python3", [path.join(process.cwd(), "scripts", "read-conversations.py")], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (signal.aborted) return reject(new Error("Request cancelled."));
      if (code !== 0) return reject(new Error(stderr.slice(0, 400) || "Could not resolve conversations in the local index."));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("The conversation index returned invalid data.")); }
    });
    child.stdin.end(JSON.stringify({ conversationIds, summaryOnly, includeText }));
  });
}

export async function POST(request: NextRequest) {
  let input: { conversationIds?: unknown; summaryOnly?: unknown; includeText?: unknown };
  try { input = await request.json() as typeof input; } catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  if (!Array.isArray(input.conversationIds) || input.conversationIds.length > 5000 || input.conversationIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
    return NextResponse.json({ error: "Provide up to 5,000 valid conversation IDs." }, { status: 400 });
  }
  try { return NextResponse.json(await resolveConversationIds([...new Set(input.conversationIds as string[])], request.signal, input.summaryOnly === true, input.includeText === true), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not resolve this list." }, { status: 500 }); }
}
