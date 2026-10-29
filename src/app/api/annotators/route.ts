import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { cleanAnnotatorName, createAnnotatorRosterStore, normalizeAnnotatorName } from "@/lib/annotator-roster.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const roster = createAnnotatorRosterStore(path.join(process.cwd(), "data"));

export async function GET() {
  try {
    return NextResponse.json({ profiles: await roster.list() }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load shared annotator profiles." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let input: { names?: unknown; name?: unknown };
  try { input = await request.json() as typeof input; }
  catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }

  const single = typeof input.name === "string" ? input.name : null;
  const names = single !== null ? [single] : input.names;
  if (!Array.isArray(names) || names.length > 200 || !names.every((name) => typeof name === "string" && cleanAnnotatorName(name))) {
    return NextResponse.json({ error: "Provide up to 200 annotator names, each between 1 and 48 characters." }, { status: 400 });
  }
  try {
    const before = single === null ? [] : await roster.list();
    const alreadyKnown = single !== null && before.some((name) => normalizeAnnotatorName(name) === normalizeAnnotatorName(single));
    if (alreadyKnown) return NextResponse.json({ error: "An annotator with that name already exists." }, { status: 409, headers: { "cache-control": "no-store" } });
    await roster.register(names as string[]);
    const profiles = await roster.list();
    const profile = single === null ? undefined : profiles.find((name) => normalizeAnnotatorName(name) === normalizeAnnotatorName(single));
    return NextResponse.json({ saved: true, profiles, profile, created: Boolean(profile && !alreadyKnown) }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not save shared annotator profiles." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  let input: { oldName?: unknown; newName?: unknown };
  try { input = await request.json() as typeof input; }
  catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  const oldName = typeof input.oldName === "string" ? input.oldName.trim() : "";
  const newName = typeof input.newName === "string" ? input.newName.trim() : "";
  if (!cleanAnnotatorName(oldName) || !cleanAnnotatorName(newName)) return NextResponse.json({ error: "Provide valid current and new annotator names." }, { status: 400 });
  try {
    if (normalizeAnnotatorName(oldName) !== normalizeAnnotatorName(newName)) {
      const names = await roster.list();
      if (names.some((name) => normalizeAnnotatorName(name) === normalizeAnnotatorName(newName))) {
        return NextResponse.json({ error: "An annotator with that name already exists." }, { status: 409 });
      }
    }
    await roster.rename(oldName, newName);
    return NextResponse.json({ saved: true, profiles: await roster.list() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not rename the shared annotator profile.";
    return NextResponse.json({ error: message }, { status: message.includes("already exists") ? 409 : 500 });
  }
}

export async function DELETE(request: NextRequest) {
  let input: { name?: unknown };
  try { input = await request.json() as typeof input; }
  catch { return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 }); }
  if (!cleanAnnotatorName(input.name)) return NextResponse.json({ error: "Provide a valid annotator name." }, { status: 400 });
  try {
    await roster.remove(input.name);
    return NextResponse.json({ saved: true, profiles: await roster.list() }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not remove the shared annotator profile." }, { status: 500 });
  }
}
