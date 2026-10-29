import { NextRequest, NextResponse } from "next/server";
import { isValidSession, sessionCookieName } from "./lib/session";

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname === "/login" || pathname.startsWith("/login/") || pathname === "/api/auth") return NextResponse.next();
  if (await isValidSession(request.cookies.get(sessionCookieName)?.value)) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  // Next sees the tunnel's loopback origin, so redirect to the fixed public
  // origin when the request arrived for our Cloudflare hostname.
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
  const requestHost = (forwardedHost ?? request.headers.get("host") ?? "").split(",")[0].trim().toLowerCase();
  const redirectOrigin = requestHost === "annotation.dvsity.de" ? "https://annotation.dvsity.de" : request.nextUrl.origin;
  return NextResponse.redirect(new URL("/login", redirectOrigin));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
