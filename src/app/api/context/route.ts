import { spawn } from "node:child_process";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const recordId = request.nextUrl.searchParams.get("recordId") ?? "";
  const targetOnly = request.nextUrl.searchParams.get("targetOnly") === "1";
  if (!recordId.trim() || recordId.length > 300) return NextResponse.json({ error: "A valid message id is required." }, { status: 400 });
  try {
    const record = await new Promise<{ context?: unknown; text?: unknown; error?: string }>((resolve, reject) => {
      const child = spawn(process.env.PYTHON || "python3", [path.join(process.cwd(), "scripts", "read-record.py")], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(stderr.slice(0, 400) || "Could not load conversation context."));
        try { resolve(JSON.parse(stdout) as { context?: unknown; text?: unknown; error?: string }); }
        catch { reject(new Error("The local message index returned invalid context data.")); }
      });
      child.stdin.end(JSON.stringify({ recordId: recordId.trim(), includeContext: !targetOnly }));
    });
    if (record.error) return NextResponse.json({ error: record.error }, { status: 404 });
    if (!Array.isArray(record.context)) return NextResponse.json({ error: "Conversation context is unavailable." }, { status: 404 });
    return NextResponse.json({ context: record.context, ...(typeof record.text === "string" ? { text: record.text } : {}) }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load conversation context." }, { status: 500 });
  }
}
