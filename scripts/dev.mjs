#!/usr/bin/env node
/**
 * `pnpm dev`: runs the API/realtime server and the Next.js web app together.
 * `pnpm start` (--prod): same, but serves a production build of the web app (run `pnpm build` first).
 * Reads ./.env if present (see .env.example).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROD = process.argv.includes("--prod");

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Leaf needs Node 22.13+ (for the built-in node:sqlite). You have ${process.versions.node}.`);
  process.exit(1);
}

function loadDotenv(file) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

const env = {
  NODE_OPTIONS: "--disable-warning=ExperimentalWarning",
  NEXT_TELEMETRY_DISABLED: "1",
  ...loadDotenv(path.join(ROOT, ".env")),
  ...process.env,
};
env.API_PORT ??= "4000";
env.WEB_PORT ??= "3000";
env.NEXT_PUBLIC_API_PORT ??= env.API_PORT;

const services = [
  { name: "api", color: 36, args: ["--filter", "@leaf/server", PROD ? "start" : "dev"] },
  { name: "web", color: 33, args: ["--filter", "@leaf/web", PROD ? "start" : "dev"] },
];

const children = services.map(({ name, color, args }) => {
  const child = spawn("pnpm", ["--silent", ...args], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `\x1b[${color}m${name.padEnd(4)}\x1b[0m │ `;
  for (const stream of [child.stdout, child.stderr]) {
    let partial = "";
    stream.setEncoding("utf8").on("data", (chunk) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop();
      for (const line of lines) process.stdout.write(prefix + line + "\n");
    });
  }
  child.on("exit", (code) => {
    process.stdout.write(`${prefix}exited with ${code}\n`);
    shutdown(code ?? 1);
  });
  return child;
});

console.log(`
  \x1b[1m🌿 Leaf\x1b[0m  ${PROD ? "production" : "dev"}
  App        http://localhost:${env.WEB_PORT}
  API + WS   http://localhost:${env.API_PORT}
  Demo       alice@leaf.dev / bob@leaf.dev  (password: leafdemo)
`);

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 800);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
