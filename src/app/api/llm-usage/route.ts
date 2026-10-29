import { NextResponse } from "next/server";
import { getLlmUsage, resetLlmUsage } from "@/lib/llm-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try { return NextResponse.json({ usage: await getLlmUsage() }, { headers: { "cache-control": "no-store" } }); }
  catch { return NextResponse.json({ error: "Could not read the LLM usage counter." }, { status: 503 }); }
}

export async function DELETE() {
  try { return NextResponse.json({ usage: await resetLlmUsage() }, { headers: { "cache-control": "no-store" } }); }
  catch { return NextResponse.json({ error: "Could not reset the LLM usage counter." }, { status: 503 }); }
}
