import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

export const newToken = () => randomBytes(32).toString("hex");

export const USER_COLORS = ["#e16259", "#d9730d", "#2f80ed", "#0f7b6c", "#9065b0", "#c14c8a", "#dfab01", "#64473a"];

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const SESSION_COOKIE = "leaf_session";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

/*
 * WebSocket tickets. In production the web app and the API live on different sites
 * (e.g. the Next app on Vercel/Orbit, the realtime server on a container host), so the
 * session cookie set through the web app's /api proxy is never sent on the WebSocket
 * handshake. The client fetches a short-lived signed ticket through the proxy instead
 * and passes it as ?ticket=. A ticket only identifies the user; access checks still run.
 */
const SECRET = process.env.LEAF_SECRET ? Buffer.from(process.env.LEAF_SECRET) : randomBytes(32);
export const TICKET_TTL_MS = 60 * 60 * 1000;

const b64url = (b: Buffer) => b.toString("base64url");

export function signTicket(userId: string, now = Date.now()): { ticket: string; expiresAt: number } {
  const expiresAt = now + TICKET_TTL_MS;
  const body = b64url(Buffer.from(`${userId}.${expiresAt}`));
  const sig = b64url(createHmac("sha256", SECRET).update(body).digest());
  return { ticket: `${body}.${sig}`, expiresAt };
}

export function verifyTicket(ticket: string | null | undefined, now = Date.now()): string | null {
  if (!ticket) return null;
  const [body, sig] = ticket.split(".");
  if (!body || !sig) return null;
  // Compare the canonical encoding, so a signature with altered padding bits is rejected too.
  const expected = Buffer.from(b64url(createHmac("sha256", SECRET).update(body).digest()));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [userId, exp] = Buffer.from(body, "base64url").toString().split(".");
  if (!userId || !exp || Number(exp) < now) return null;
  return userId;
}
