"use client";
import { useEffect, useSyncExternalStore } from "react";
import { api, clearWsTicket } from "./api";
import type { User } from "./store";

export interface Session {
  user: User | null;
  workspaces: Array<{ id: string; name: string; icon: string; role: string; expires_at?: number | null }>;
  loaded: boolean;
}

let session: Session = { user: null, workspaces: [], loaded: false };
const listeners = new Set<() => void>();
let inflight: Promise<Session> | null = null;

function set(s: Session) {
  session = s;
  for (const l of listeners) l();
}

export function loadSession(force = false): Promise<Session> {
  if (inflight && !force) return inflight;
  inflight = api<{ user: User | null; workspaces: Session["workspaces"] }>("GET", "/api/auth/me")
    .then((r) => {
      set({ user: r.user, workspaces: r.workspaces, loaded: true });
      return session;
    })
    .catch(() => {
      set({ user: null, workspaces: [], loaded: true });
      return session;
    });
  return inflight;
}

export function useSession(): Session {
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => session,
    () => session,
  );
  useEffect(() => {
    if (!session.loaded) void loadSession();
  }, []);
  return s;
}

export async function logout() {
  await api("POST", "/api/auth/logout");
  clearWsTicket();
  localStorage.removeItem("leaf:last");
  set({ user: null, workspaces: [], loaded: true });
}

export function useTheme(): [string, (t: string) => void] {
  const theme = useSyncExternalStore(
    (l) => {
      window.addEventListener("leaf-theme", l);
      return () => window.removeEventListener("leaf-theme", l);
    },
    () => document.documentElement.dataset.theme ?? "light",
    () => "light",
  );
  return [
    theme,
    (t: string) => {
      document.documentElement.dataset.theme = t;
      localStorage.setItem("leaf:theme", t);
      window.dispatchEvent(new Event("leaf-theme"));
    },
  ];
}
