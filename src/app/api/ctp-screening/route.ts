import { spawn } from "node:child_process";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { lookupCtpLabels } from "@/lib/ctp-screening";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(process.env.PYTHON || "python3", [path.join(process.cwd(), "scripts", "query-index.py")], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(stderr.slice(0, 500) || "Could not load CTP screening counts."));
        try { resolve(JSON.parse(stdout) as Record<string, unknown>); }
        catch { reject(new Error("The CTP screening index returned invalid data.")); }
      });
      child.stdin.end(JSON.stringify({ action: "ctp_counts" }));
    });
    return NextResponse.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load CTP screening counts." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  let input: { action?: unknown; recordIds?: unknown };
  try { input = await request.json() as typeof input; }
  catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  if (input.action !== "labels") return NextResponse.json({ error: "Action must be labels." }, { status: 400 });
  if (!Array.isArray(input.recordIds) || input.recordIds.length > 100_000
      || input.recordIds.some((id) => typeof id !== "string" || !id || id.length > 300)) {
    return NextResponse.json({ error: "Provide at most 100,000 non-empty record IDs of at most 300 characters." }, { status: 400 });
  }
  try {
    const result = await lookupCtpLabels([...new Set(input.recordIds as string[])]);
    return NextResponse.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load MSD1 CTP labels." }, { status: 503 });
  }
}
