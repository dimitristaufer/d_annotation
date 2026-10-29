import { spawn } from "node:child_process";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const band = request.nextUrl.searchParams.get("band") ?? "primary";
  const page = request.nextUrl.searchParams.get("page") ?? "1";
  const limit = request.nextUrl.searchParams.get("limit") ?? "24";
  try {
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(process.env.PYTHON || "python3", [path.join(process.cwd(), "scripts", "query-embedding-similarities.py")], {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(stderr.slice(0, 500) || "Could not load embedding similarity candidates."));
        try { resolve(JSON.parse(stdout) as Record<string, unknown>); }
        catch { reject(new Error("The local similarity index returned invalid data.")); }
      });
      child.stdin.end(JSON.stringify({ band, page, limit }));
    });
    return NextResponse.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load embedding similarity candidates." }, { status: 503 });
  }
}
