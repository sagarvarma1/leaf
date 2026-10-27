import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Leaf, type LeafOptions } from "../src/app.js";
import { createHttpServer } from "../src/http.js";
import { seed } from "../src/seed.js";

export interface TestServer {
  leaf: Leaf;
  url: string;
  wsUrl: string;
  dbFile: string;
  dir: string;
  close(): Promise<void>;
  api: (token: string | null, method: string, p: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any; text: string; headers: Headers }>;
  login: (email: string, password?: string) => Promise<{ token: string; user: any; workspaces: any[] }>;
}

export async function startServer(opts: { seed?: boolean; dir?: string; leaf?: Partial<LeafOptions> } = {}): Promise<TestServer> {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "leaf-test-"));
  const dbFile = path.join(dir, "leaf.db");
  const leaf = new Leaf({ dbFile, indexDebounceMs: 20, snapshotIntervalMs: 60_000, aiModel: null, ...opts.leaf });
  if (opts.seed !== false) seed(leaf);
  const { server, wss } = createHttpServer(leaf);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const api: TestServer["api"] = async (token, method, p, body, headers = {}) => {
    const res = await fetch(url + p, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* markdown etc */
    }
    return { status: res.status, body: parsed, text, headers: res.headers };
  };
  return {
    leaf,
    url,
    wsUrl: `ws://127.0.0.1:${port}`,
    dbFile,
    dir,
    api,
    async login(email, password = "leafdemo") {
      const r = await api(null, "POST", "/api/auth/login", { email, password });
      if (r.status !== 200) throw new Error(`login failed: ${r.text}`);
      return r.body;
    },
    async close() {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => server.close(() => r()));
      leaf.close();
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 5000, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}
