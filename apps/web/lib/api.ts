"use client";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let shareToken: string | null = null;
export const setShareToken = (t: string | null) => (shareToken = t);
export const getShareToken = () => shareToken;

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (shareToken) headers["x-leaf-share"] = shareToken;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Base URL for WebSockets: same host as the page, API port. */
export function wsBase(): string {
  const env = process.env.NEXT_PUBLIC_WS_URL;
  if (env) return env.replace(/\/$/, "");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const port = process.env.NEXT_PUBLIC_API_PORT ?? "4000";
  return `${proto}://${location.hostname}:${port}`;
}

/*
 * WebSocket tickets. When the realtime server is on another site than the web app (the
 * usual hosted setup), the session cookie isn't sent on the WebSocket handshake, so
 * sockets authenticate with a short-lived signed ticket fetched through the /api proxy.
 * Share-link guests without an account have no ticket and use the share token instead.
 */
let ticket: { value: string; expiresAt: number } | null = null;
let ticketRequest: Promise<string | null> | null = null;

export function wsTicket(): Promise<string | null> {
  if (ticket && ticket.expiresAt - Date.now() > 5 * 60_000) return Promise.resolve(ticket.value);
  ticketRequest ??= api<{ ticket: string; expiresAt: number }>("GET", "/api/auth/ws-ticket")
    .then((r) => {
      ticket = { value: r.ticket, expiresAt: r.expiresAt };
      return r.ticket;
    })
    .catch(() => ticket?.value ?? null)
    .finally(() => (ticketRequest = null));
  return ticketRequest;
}

export const clearWsTicket = () => (ticket = null);
