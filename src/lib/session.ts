const COOKIE_NAME = "prescreen_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const encoder = new TextEncoder();

function decodeBase64Url(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signingKey() {
  const secret = process.env.PRESCREEN_SESSION_SECRET;
  if (!secret) throw new Error("PRESCREEN_SESSION_SECRET is not configured");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function createSessionToken() {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `prescreen:${expiresAt}`;
  const signature = await crypto.subtle.sign("HMAC", await signingKey(), encoder.encode(payload));
  return { token: `${expiresAt}.${encodeBase64Url(signature)}`, maxAge: SESSION_TTL_SECONDS };
}

export async function isValidSession(token?: string) {
  if (!token) return false;
  const [expiryText, signatureText, extra] = token.split(".");
  const expiresAt = Number(expiryText);
  if (extra || !Number.isInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000) || !signatureText) return false;
  try {
    return await crypto.subtle.verify("HMAC", await signingKey(), decodeBase64Url(signatureText), encoder.encode(`prescreen:${expiresAt}`));
  } catch {
    return false;
  }
}

export const sessionCookieName = COOKIE_NAME;
