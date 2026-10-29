import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createSessionToken, isValidSession, sessionCookieName } from "@/lib/session";
import { clearLoginFailures, getLoginRetryAfter, recordLoginFailure } from "@/lib/login-rate-limit";

export const runtime = "nodejs";
const cookieOptions = () => ({ httpOnly: true, sameSite: "strict" as const, path: "/", secure: process.env.NODE_ENV === "production" });

function passwordMatches(candidate: unknown) {
  const expected = process.env.PRESCREEN_PASSWORD;
  if (typeof candidate !== "string" || candidate.length > 256 || !expected) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

export async function GET(request: NextRequest) {
  return NextResponse.json({ authenticated: await isValidSession(request.cookies.get(sessionCookieName)?.value) });
}

export async function POST(request: NextRequest) {
  if (!process.env.PRESCREEN_PASSWORD || !process.env.PRESCREEN_SESSION_SECRET) {
    return NextResponse.json({ error: "Password protection is not configured on this server." }, { status: 503 });
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 4096) return NextResponse.json({ error: "Login request is too large." }, { status: 413 });
  let body: { password?: unknown };
  try { body = await request.json() as { password?: unknown }; }
  catch { return NextResponse.json({ error: "Enter the password to continue." }, { status: 400 }); }
  // Only trust Cloudflare's client IP header here. The usual forwarded-for
  // headers can be supplied by a caller when the origin is reached directly.
  const clientIp = (request.headers.get("cf-connecting-ip")?.trim() || request.headers.get("x-real-ip")?.trim() || "unknown").slice(0, 128);
  const retryAfter = await getLoginRetryAfter(clientIp);
  if (retryAfter > 0) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429, headers: { "retry-after": String(retryAfter), "cache-control": "no-store" } });
  if (!passwordMatches(body.password)) {
    await recordLoginFailure(clientIp);
    return NextResponse.json({ error: "That password did not match." }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  await clearLoginFailures(clientIp);
  const { token, maxAge } = await createSessionToken();
  const response = NextResponse.json({ authenticated: true });
  response.cookies.set(sessionCookieName, token, { ...cookieOptions(), maxAge });
  return response;
}

export async function DELETE(request: NextRequest) {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(sessionCookieName, "", { ...cookieOptions(), maxAge: 0 });
  return response;
}
