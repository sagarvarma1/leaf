#!/usr/bin/env node
/**
 * End-to-end checks in a real headless browser (Playwright + Chromium).
 *
 * Boots the API server and the Next.js app on spare ports with a throwaway data dir,
 * then drives two signed-in users (Alice and Bob, separate browser contexts) through
 * the main flows, plus an anonymous share-link visitor. Nothing is mocked.
 *
 *   pnpm e2e                 # needs: npx playwright install chromium (once)
 *   node scripts/e2e.mjs --keep   # leave servers running afterwards for poking around
 *   SHOTS=docs/screenshots node scripts/e2e.mjs   # also save screenshots
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Let context.route() see the service worker's own requests, so "offline" really cuts
// off the worker too (setOffline alone doesn't reach it).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_PORT = Number(process.env.E2E_API_PORT ?? 4310);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3310);
const WEB = `http://localhost:${WEB_PORT}`;
const KEEP = process.argv.includes("--keep");
const SHOTS = process.env.SHOTS ? path.resolve(ROOT, process.env.SHOTS) : null;
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leaf-e2e-"));
const children = [];

function start(name, args, env) {
  const child = spawn("pnpm", ["--silent", ...args], {
    cwd: ROOT,
    env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning", NEXT_TELEMETRY_DISABLED: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const log = fs.createWriteStream(path.join(tmp, `${name}.log`));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push(child);
  return child;
}

async function waitHttp(url, ms = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${url}`);
}

function cleanup() {
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {}
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

// ---------------------------------------------------------------- tiny harness
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[2m(${Date.now() - t0}ms)\x1b[0m`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n    ${String(err?.stack ?? err).split("\n").slice(0, 4).join("\n    ")}`);
    if (SHOTS) await Promise.all(pages().map((p, i) => p.screenshot({ path: path.join(tmp, `fail-${results.length}-${i}.png`) }).catch(() => {})));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 10_000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(`timed out: ${label} (last: ${String(last).slice(0, 200)})`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

let A, B, browser;
const pages = () => [A, B].filter(Boolean);
/** Visible editor text without remote caret labels (which differ per viewer). */
const editorText = (p) =>
  p.evaluate(() => {
    const el = document.querySelector(".leaf-editor")?.cloneNode(true);
    if (!el) return "";
    el.querySelectorAll(".collaboration-cursor__caret").forEach((n) => n.remove());
    document.body.appendChild(el);
    const text = el.innerText.replace(/[\u2060\u200b]/g, "").replace(/\s+/g, " ").trim();
    el.remove();
    return text;
  });
/** The page's records rendered as an editor document (identical on every converged client). */
const docXml = (p) => p.evaluate(() => window.__leafDocJSON(location.pathname.split("/").pop()));
const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, `${name}.png`) });

async function login(ctx, who) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log(`    [${who} pageerror] ${e.message}`));
  await p.goto(`${WEB}/login`);
  await p.click(`[data-testid=demo-${who}]`);
  await p.waitForSelector("[data-testid=editor]", { timeout: 60_000 });
  return p;
}

async function openPage(p, title) {
  await p.locator("[data-testid=page-tree] [data-testid=tree-row]", { hasText: title }).first().click();
  await until(async () => (await p.locator(".leaf-editor .page-title").innerText()).trim() === title, `open ${title}`, 20_000);
}

/** Open any page by title (sub-pages too, without expanding the sidebar tree). */
async function gotoPage(p, title) {
  const ws = p.url().split("/w/")[1].split("/")[0];
  const { blocks } = await (await p.request.get(`${WEB}/api/workspaces/${ws}/pages`)).json();
  const page = blocks.find((b) => b.type === "page" && b.properties.title === title && !b.archived);
  await p.evaluate((id) => window.dispatchEvent(new CustomEvent("leaf-navigate", { detail: id })), page.id);
  await until(async () => (await p.locator(".leaf-editor .page-title").innerText()).trim() === title, `open ${title}`, 20_000);
}

/** Put the caret at the end of the last block of the page body. */
/** HTML5 drag and drop with real mouse steps (Playwright's dragTo can stall on PM drags). */
async function drag(p, from, to, offset = {}) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await p.mouse.down();
  await p.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 3 });
  await p.mouse.move(b.x + (offset.x ?? b.width / 2), b.y + (offset.y ?? b.height / 2), { steps: 8 });
  await p.mouse.up();
}

/** After creating a page: wait for the new, empty page and put the caret in its title. */
async function onNewPage(p, prevUrl) {
  await until(async () => p.url() !== prevUrl, "navigated to the new page");
  await p.locator(".leaf-editor .page-title.is-empty").waitFor();
  await p.locator(".leaf-editor .page-title").click();
}

/** Put the caret `offset` characters into the first occurrence of `needle` in the editor. */
async function caretAt(p, needle, offset) {
  await p.evaluate(
    ({ needle, offset }) => {
      const ed = window.__leafEditor;
      let at = null;
      ed.state.doc.descendants((node, pos) => {
        if (at !== null || !node.isText) return at === null;
        const i = node.text.indexOf(needle);
        if (i >= 0) at = pos + i + offset;
        return false;
      });
      ed.commands.focus();
      ed.commands.setTextSelection(at);
    },
    { needle, offset },
  );
  await p.waitForFunction(() => document.activeElement?.classList.contains("ProseMirror"));
  await sleep(50);
}

/** Text of each paragraph in the editor (list items' and toggles' text included), in order. */
const paragraphs = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll("[data-testid=editor] p")].map((e) => {
      const c = e.cloneNode(true);
      c.querySelectorAll(".collaboration-cursor__caret").forEach((n) => n.remove());
      return c.textContent;
    }),
  );

async function caretToEnd(p) {
  // TipTap focuses on the next animation frame: wait until the editor really has focus.
  await p.evaluate(() => window.__leafEditor.commands.focus("end"));
  await p.waitForFunction(() => document.activeElement?.classList.contains("ProseMirror"));
  await sleep(50);
}

async function main() {
  console.log(`\n🌿 Leaf e2e  (data: ${tmp})\n`);
  // Leaf AI runs on the scripted mock model: deterministic, no network or API key.
  start("api", ["--filter", "@leaf/server", "start"], { API_PORT: String(API_PORT), LEAF_DATA_DIR: path.join(tmp, "data"), LEAF_AI_MOCK: "1", LEAF_AI_TYPING_MS: "40" });
  // The page is served from localhost but WebSockets go to 127.0.0.1: a different site, so
  // the session cookie is never sent on the socket, exactly like a split deployment (web
  // app on Vercel/Orbit, realtime server elsewhere). Every socket must use a ticket.
  start("web", ["--filter", "@leaf/web", "dev"], { WEB_PORT: String(WEB_PORT), API_PORT: String(API_PORT), NEXT_PUBLIC_WS_URL: `ws://127.0.0.1:${API_PORT}` });
  await waitHttp(`http://127.0.0.1:${API_PORT}/api/health`);
  await waitHttp(`${WEB}/login`, 180_000);
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  browser = await chromium.launch();
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctxA.grantPermissions(["clipboard-read", "clipboard-write"]);

  await test("Alice and Bob log in (demo accounts, session cookie)", async () => {
    A = await login(ctxA, "alice");
    B = await login(ctxB, "bob");
    const cookies = await ctxA.cookies();
    assert(cookies.some((c) => c.name === "leaf_session" && c.httpOnly), "httpOnly session cookie");
    await shot(A, "welcome");
  });

  await test("both open Scratchpad and see each other's presence", async () => {
    await openPage(A, "Scratchpad");
    await openPage(B, "Scratchpad");
    await until(async () => (await A.locator("[data-testid=presence] .avatar").count()) >= 1, "Alice sees Bob's avatar");
    await until(async () => (await B.locator("[data-testid=presence] .avatar").getAttribute("title"))?.includes("Alice"), "Bob sees Alice's avatar");
  });

  await test("typing syncs live in both directions, with named remote cursors", async () => {
    await caretToEnd(A);
    await A.keyboard.press("Enter");
    await A.keyboard.type("Hello from Alice");
    await until(async () => (await editorText(B)).includes("Hello from Alice"), "Bob sees Alice's text");
    await caretToEnd(B);
    await B.keyboard.press("Enter");
    await B.keyboard.type("Hi Alice, Bob here");
    await until(async () => (await editorText(A)).includes("Hi Alice, Bob here"), "Alice sees Bob's text");
    await until(async () => (await A.locator(".collaboration-cursor__label", { hasText: "Bob" }).count()) > 0, "Bob's caret label at Alice");
  });

  await test("concurrent typing in the same paragraph converges", async () => {
    await A.locator(".leaf-editor p", { hasText: "Hello from Alice" }).click();
    await A.keyboard.press("End");
    await B.locator(".leaf-editor p", { hasText: "Hello from Alice" }).click();
    await B.keyboard.press("Home");
    await Promise.all([A.keyboard.type(" [A1][A2][A3]", { delay: 15 }), B.keyboard.type("[B1][B2][B3] ", { delay: 15 })]);
    await until(async () => (await docXml(A)) === (await docXml(B)), "both clients' documents identical");
    await until(async () => (await editorText(A)) === (await editorText(B)), "both editors render the same text");
    const t = await editorText(A);
    for (const tok of ["[A1][A2][A3]", "[B1][B2][B3]", "Hello from Alice"]) assert(t.includes(tok), `missing ${tok}`);
    await shot(A, "collab-alice");
    await shot(B, "collab-bob");
  });

  await test("slash menu creates blocks (heading, to-do, callout, code)", async () => {
    await caretToEnd(A);
    await A.keyboard.press("Enter");
    await A.keyboard.type("/head");
    await A.waitForSelector("[data-testid=slash-menu]");
    await shot(A, "slash-menu");
    await A.keyboard.press("Enter"); // Heading 1
    await A.keyboard.type("Slash heading");
    await A.keyboard.press("Enter");
    await A.keyboard.type("/to-do");
    await A.keyboard.press("Enter");
    await A.keyboard.type("Slash task");
    await A.keyboard.press("Enter");
    await A.keyboard.press("Enter"); // leave the list
    await A.keyboard.type("/callout");
    await A.keyboard.press("Enter");
    await A.keyboard.type("Slash callout");
    await A.keyboard.press("Enter");
    await A.keyboard.type("/code");
    await A.keyboard.press("Enter");
    await A.keyboard.type("const x = 1;");
    await A.keyboard.press("ArrowDown"); // leave the code block
    await until(async () => (await B.locator(".leaf-editor h1:not(.page-title)", { hasText: "Slash heading" }).count()) === 1, "h1 at Bob");
    await until(async () => (await B.locator(".leaf-editor ul[data-type=taskList] li", { hasText: "Slash task" }).count()) === 1, "to-do at Bob");
    await until(async () => (await B.locator(".leaf-editor .callout", { hasText: "Slash callout" }).count()) === 1, "callout at Bob");
    await until(async () => (await B.locator(".leaf-editor .code-block", { hasText: "const x = 1;" }).count()) === 1, "code at Bob");
  });

  await test("markdown shortcuts (#, -, [], >, ```, ---)", async () => {
    await caretToEnd(A);
    await A.keyboard.press("Enter");
    await A.keyboard.press("Enter");
    const lines = [
      ["## ", "MD heading"],
      ["- ", "MD bullet"],
    ];
    for (const [prefix, text] of lines) {
      await A.keyboard.type(prefix + text);
      await A.keyboard.press("Enter");
      if (prefix === "- ") await A.keyboard.press("Enter");
    }
    await A.keyboard.type("[] MD todo");
    await A.keyboard.press("Enter");
    await A.keyboard.press("Enter");
    await A.keyboard.type("> MD quote");
    await A.keyboard.press("Enter");
    await A.keyboard.press("Enter");
    await A.keyboard.type("---");
    await until(async () => (await A.locator(".leaf-editor h2", { hasText: "MD heading" }).count()) === 1, "h2");
    await until(async () => (await A.locator(".leaf-editor ul:not([data-type]) li", { hasText: "MD bullet" }).count()) === 1, "bullet");
    await until(async () => (await A.locator(".leaf-editor ul[data-type=taskList] li", { hasText: "MD todo" }).count()) === 1, "todo");
    await until(async () => (await A.locator(".leaf-editor blockquote", { hasText: "MD quote" }).count()) === 1, "quote");
    await until(async () => (await A.locator(".leaf-editor hr").count()) >= 1, "divider");
  });

  await test("floating toolbar applies bold; Bob sees the mark", async () => {
    const para = A.locator(".leaf-editor p", { hasText: "Hi Alice, Bob here" });
    await para.click({ clickCount: 3 });
    await A.waitForSelector("[data-testid=format-toolbar]", { state: "visible" });
    await shot(A, "toolbar");
    await A.click("[data-testid=tb-bold]");
    await until(async () => (await B.locator(".leaf-editor strong", { hasText: "Hi Alice, Bob here" }).count()) === 1, "bold at Bob");
  });

  await test("undo reverts only my own change (inverse ops of my own transactions)", async () => {
    await caretToEnd(B);
    await B.keyboard.press("Enter");
    await B.keyboard.type("bob-undo-me");
    await until(async () => (await editorText(A)).includes("bob-undo-me"), "A sees text");
    await sleep(600);
    await B.keyboard.press(`${MOD}+z`);
    await until(async () => !(await editorText(A)).includes("bob-undo-me"), "undo propagates");
    assert((await editorText(A)).includes("Slash heading"), "Alice's work survives Bob's undo");
  });

  await test("Tab nests a block inside a toggle; Shift+Tab lifts it out", async () => {
    await caretToEnd(A);
    await A.keyboard.press("Enter");
    await A.keyboard.type("/toggle");
    await A.keyboard.press("Enter");
    await A.keyboard.type("Toggle head");
    await A.keyboard.press("Enter"); // a child paragraph inside the toggle
    await A.keyboard.press("Shift+Tab"); // lift it out to the top level
    await A.keyboard.type("nested line");
    const inToggle = () => A.locator(".leaf-editor .toggle .toggle-content p", { hasText: "nested line" }).count();
    await until(async () => (await inToggle()) === 0, "starts at top level");
    await A.keyboard.press("Tab");
    await until(async () => (await inToggle()) === 1, "Tab moves it into the toggle");
    await until(async () => (await B.locator(".leaf-editor .toggle .toggle-content p", { hasText: "nested line" }).count()) === 1, "nesting syncs to Bob");
    await A.keyboard.press("Shift+Tab");
    await until(async () => (await inToggle()) === 0, "Shift+Tab lifts it out");
  });

  await test("drag handle reorders blocks", async () => {
    const first = A.locator(".leaf-editor > p", { hasText: "A blank-ish page" });
    const target = A.locator(".leaf-editor h1:not(.page-title)", { hasText: "Slash heading" });
    await first.hover();
    const grip = A.locator("[data-testid=block-grip]");
    await grip.waitFor({ state: "visible" });
    const tb = await target.boundingBox();
    await drag(A, grip, target, { x: 40, y: tb.height - 2 });
    await until(async () => {
      const t = await editorText(B);
      return t.indexOf("A blank-ish page") > t.indexOf("Slash heading");
    }, "moved block visible to Bob");
  });

  await test("block menu: turn into heading, duplicate, delete", async () => {
    const block = A.locator(".leaf-editor > p", { hasText: "Hello from Alice" });
    await block.hover();
    await A.click("[data-testid=block-grip]");
    await A.waitForSelector("[data-testid=block-menu]");
    await shot(A, "block-menu");
    await A.click("[data-testid=turn-h3]");
    await until(async () => (await B.locator(".leaf-editor h3", { hasText: "Hello from Alice" }).count()) === 1, "turned into h3");
    await A.locator(".leaf-editor h3", { hasText: "Hello from Alice" }).hover();
    await A.click("[data-testid=block-grip]");
    await A.click("[data-testid=block-duplicate]");
    await until(async () => (await A.locator(".leaf-editor h3", { hasText: "Hello from Alice" }).count()) === 2, "duplicated");
    await A.locator(".leaf-editor h3", { hasText: "Hello from Alice" }).last().hover();
    await A.click("[data-testid=block-grip]");
    await A.click("[data-testid=block-delete]");
    await until(async () => (await B.locator(".leaf-editor h3", { hasText: "Hello from Alice" }).count()) === 1, "deleted at Bob");
  });

  await test("@mention a person and a page", async () => {
    await caretToEnd(A);
    await A.keyboard.press("Enter");
    await A.keyboard.type("ping @bo");
    await A.waitForSelector("[data-testid=mention-menu]");
    await A.keyboard.press("Enter");
    await A.keyboard.type("see @Engin");
    await A.waitForSelector("[data-testid=mention-menu]");
    await A.keyboard.press("Enter");
    await until(async () => (await B.locator('.leaf-editor .mention[data-kind="user"]', { hasText: "Bob Rivera" }).count()) >= 1, "user mention at Bob");
    await until(async () => (await B.locator('.leaf-editor .mention[data-kind="page"]', { hasText: "Engineering Wiki" }).count()) >= 1, "page mention at Bob");
  });

  await test("Tab gives any block children; turn into keeps them", async () => {
    await caretToEnd(A);
    await A.keyboard.press("Enter");
    await A.keyboard.type("Parent para");
    await A.keyboard.press("Enter");
    await A.keyboard.type("Child para");
    await A.keyboard.press("Tab");
    const nested = (p) => p.locator(".leaf-editor .nest", { hasText: "Child para" });
    await until(async () => (await nested(B).count()) === 1, "nest syncs to Bob");
    assert((await nested(B).locator("> p").first().innerText()).includes("Parent para"), "parent is the nest's head");
    const pageId = A.url().split("/").pop();
    await until(async () => {
      const { blocks } = await (await A.request.get(`${WEB}/api/pages/${pageId}/blocks`)).json();
      const parent = blocks.find((b) => b.properties.rich_text?.[0]?.text === "Parent para");
      const child = blocks.find((b) => b.properties.rich_text?.[0]?.text === "Child para");
      return parent && child && child.parent_id === parent.id && parent.content.includes(child.id);
    }, "projected as parent/child blocks");
    // Turn the parent into a heading: the child stays nested under it.
    await A.locator(".leaf-editor .nest > p", { hasText: "Parent para" }).hover();
    await A.click("[data-testid=block-grip]");
    await A.click("[data-testid=turn-h2]");
    await until(async () => (await B.locator(".leaf-editor .nest > h2", { hasText: "Parent para" }).count()) === 1, "head turned into a heading");
    assert((await nested(B).count()) === 1, "child still nested");
    await shot(A, "nesting");
  });

  await test("columns: slash command, and drag a block onto another's edge", async () => {
    await caretToEnd(A);
    await A.keyboard.press("Enter");
    await A.keyboard.type("/columns");
    await A.waitForSelector("[data-testid=slash-menu]");
    await A.keyboard.press("Enter");
    await A.keyboard.type("Left col");
    await A.locator(".leaf-editor .column-list .column").nth(1).locator("p").click();
    await A.keyboard.type("Right col");
    const cols = (p) => p.locator(".leaf-editor .column-list", { hasText: "Left col" }).locator(".column");
    await until(async () => (await cols(B).count()) === 2 && (await cols(B).nth(1).innerText()).includes("Right col"), "columns at Bob");
    // Drag one paragraph onto the right edge of another.
    await caretToEnd(A);
    await A.keyboard.press("ArrowDown");
    await A.evaluate(() => {
      const ed = window.__leafEditor;
      const end = ed.state.doc.content.size;
      ed.chain().insertContentAt(end, [{ type: "paragraph", content: [{ type: "text", text: "Side A" }] }, { type: "paragraph", content: [{ type: "text", text: "Side B" }] }]).run();
    });
    const sideB = A.locator(".leaf-editor > p", { hasText: "Side B" });
    const sideA = A.locator(".leaf-editor > p", { hasText: "Side A" });
    // Scroll first: the handle hides on scroll, and hover()'s own scroll can land after its mousemove.
    await sideB.scrollIntoViewIfNeeded();
    await sleep(150);
    await sideB.hover();
    const grip = A.locator("[data-testid=block-grip]");
    await grip.waitFor({ state: "visible" });
    const box = await sideA.boundingBox();
    await drag(A, grip, sideA, { x: box.width - 12, y: box.height / 2 });
    const pair = (p) => p.locator(".leaf-editor .column-list", { hasText: "Side A" });
    await until(async () => (await pair(B).count()) === 1 && (await pair(B).innerText()).includes("Side B"), "drag to the edge made columns");
    const order = await pair(B).locator(".column").allInnerTexts();
    assert(order[0].includes("Side A") && order[1].includes("Side B"), `dropped on the right: ${JSON.stringify(order)}`);
    await shot(A, "columns");
  });

  await test("Leaf AI edits live as a collaborator; Discard reverts only its changes", async () => {
    await A.click("[data-testid=ai-btn]");
    await A.waitForSelector("[data-testid=ai-panel]");
    await A.locator("[data-testid=ai-suggestion]", { hasText: "action-item checklist" }).click();
    // Bob sees Leaf AI join the page and type.
    await until(async () => (await B.locator("[data-testid=presence] .avatar[title='Leaf AI is here']").count()) === 1, "AI avatar at Bob");
    await until(async () => (await B.locator(".collaboration-cursor__label", { hasText: "Leaf AI" }).count()) === 1, "AI cursor at Bob");
    await shot(B, "ai-typing");
    await until(async () => (await A.locator("[data-testid=ai-discard]").count()) === 1, "run finished and reviewable", 20_000);
    await until(async () => (await B.locator(".leaf-editor ul[data-type=taskList] li", { hasText: "Write the announcement" }).count()) === 1, "AI checklist at Bob");
    await shot(A, "ai-panel");
    await A.click("[data-testid=ai-discard]");
    await until(async () => (await B.locator(".leaf-editor h2", { hasText: "Action items" }).count()) === 0, "discard reaches Bob");
    assert((await editorText(B)).includes("Hello from Alice"), "earlier human edits untouched");
    // Questions get an answer with citations to workspace pages.
    await A.fill("[data-testid=ai-input]", "What did we decide about offline editing?");
    await A.press("[data-testid=ai-input]", "Enter");
    const cite = A.locator("[data-testid=ai-citation]").first();
    await cite.waitFor({ timeout: 20_000 });
    const cited = (await cite.innerText()).replace("↗", "").trim();
    await cite.click();
    await until(async () => (await A.locator(".leaf-editor .page-title").innerText()).trim() === cited, "citation opens the page");
    await openPage(A, "Scratchpad");
  });

  await test("edits are projected into the block table (REST API)", async () => {
    const pageUrl = A.url();
    const pageId = pageUrl.split("/").pop();
    await until(async () => {
      const r = await A.request.get(`${WEB}/api/pages/${pageId}/blocks`);
      const body = await r.json();
      const types = new Set(body.blocks.map((b) => b.type));
      const text = JSON.stringify(body.blocks);
      return ["heading_1", "to_do", "callout", "code", "quote", "divider", "bulleted_list_item", "toggle"].every((t) => types.has(t)) && text.includes("Slash task") && text.includes('"mention"');
    }, "block records contain the new blocks", 10_000);
    const md = await (await A.request.get(`${WEB}/api/pages/${pageId}/export`)).text();
    assert(md.includes("# Slash heading") || md.includes("## Slash heading"), "markdown export has heading");
    assert(md.includes("- [ ] Slash task"), "markdown export has to-do");
  });

  await test("offline edits on both sides merge on reconnect", async () => {
    try {
      await offlineMerge();
    } finally {
      await ctxB.setOffline(false);
    }
  });
  async function offlineMerge() {
    await ctxB.setOffline(true);
    await until(async () => (await B.locator("[data-testid=offline-pill]").count()) === 1, "Bob sees offline pill");
    await caretToEnd(B);
    await B.keyboard.press("Enter");
    await B.keyboard.type("Bob wrote this offline");
    await caretToEnd(A);
    await A.keyboard.press("Enter");
    await A.keyboard.type("Alice wrote this while Bob was away");
    await sleep(500);
    assert(!(await editorText(A)).includes("Bob wrote this offline"), "not yet synced");
    await shot(B, "offline");
    await ctxB.setOffline(false);
    await until(async () => {
      const [a, b] = [await editorText(A), await editorText(B)];
      return a === b && (await docXml(A)) === (await docXml(B)) && a.includes("Bob wrote this offline") && a.includes("Alice wrote this while Bob was away");
    }, "converged after reconnect", 20_000);
  }

  await test("Enter in the middle of a line someone is typing in: their text follows into the new block", async () => {
    await caretToEnd(A);
    await A.keyboard.press("Enter");
    await A.keyboard.type("Hello wonderful world");
    await until(async () => (await paragraphs(B)).includes("Hello wonderful world"), "Bob has the line");
    // Bob, offline so the race is deterministic, types inside "world".
    await ctxB.setOffline(true);
    try {
      await caretAt(B, "world", 2);
      await B.keyboard.type("XYZ");
      // Alice presses Enter right before "world".
      await caretAt(A, "world", 0);
      await A.keyboard.press("Enter");
    } finally {
      await ctxB.setOffline(false);
    }
    for (const p of [A, B]) {
      await until(async () => {
        const ps = await paragraphs(p);
        const i = ps.indexOf("Hello wonderful ");
        return i >= 0 && ps[i + 1] === "woXYZrld";
      }, "Bob's typing is in the new block", 20_000);
    }
    assert((await docXml(A)) === (await docXml(B)), "identical documents");
  });

  await test("two tabs offline: a tab closed before reconnecting still delivers its edits", async () => {
    const ctxT = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    try {
      const T1 = await login(ctxT, "alice");
      await openPage(T1, "Scratchpad");
      const T2 = await ctxT.newPage();
      await T2.goto(T1.url());
      await T2.waitForSelector("[data-testid=editor]", { timeout: 60_000 });
      await ctxT.setOffline(true);
      await caretToEnd(T1);
      await T1.keyboard.press("Enter");
      await T1.keyboard.type("from the closed tab");
      await sleep(300);
      await T1.close();
      await caretToEnd(T2);
      await T2.keyboard.press("Enter");
      await T2.keyboard.type("from the open tab");
      await ctxT.setOffline(false);
      for (const line of ["from the closed tab", "from the open tab"]) await until(async () => (await editorText(B)).includes(line), `Bob gets "${line}"`, 30_000);
    } finally {
      await ctxT.close();
    }
  });

  await test("renaming in the editor title updates the other user's sidebar live", async () => {
    const prev = A.url();
    await A.locator("[data-testid=new-page]").click();
    await onNewPage(A, prev);
    await A.keyboard.type("Launch plan");
    await until(async () => (await B.locator("[data-testid=page-tree] [data-testid=tree-row]", { hasText: "Launch plan" }).count()) === 1, "Bob's sidebar shows new page");
    await A.keyboard.press("Enter");
    await A.keyboard.type("First line of the plan");
  });

  await test("sidebar: nest a sub-page, set an icon, favorite, trash and restore", async () => {
    const row = A.locator("[data-testid=tree-row]", { hasText: "Launch plan" });
    await row.hover();
    const prev = A.url();
    await row.locator("[data-testid=tree-add]").click();
    await onNewPage(A, prev);
    await A.keyboard.type("Sub page");
    await until(async () => (await A.locator("[data-testid=breadcrumbs]").innerText()).includes("Launch plan"), "breadcrumbs show parent");
    await until(async () => (await A.locator("[data-testid=tree-row]", { hasText: "Sub page" }).count()) === 1, "sub page in tree");
    // Parent page shows a link block to the sub-page
    await openPage(A, "Launch plan");
    await until(async () => (await A.locator(".leaf-editor .page-link", { hasText: "Sub page" }).count()) === 1, "page link block");
    // icon
    await A.click("[data-testid=add-icon]");
    await A.locator("[data-testid=emoji-picker] .emoji-grid button").nth(3).click();
    await until(async () => (await B.locator("[data-testid=tree-row]", { hasText: "Launch plan" }).locator(".tree-icon").innerText()) === "🚀", "icon at Bob");
    // favorite
    await A.click("[data-testid=favorite-btn]");
    await until(async () => (await A.locator(".sb-section", { hasText: "Favorites" }).locator(".tree-row", { hasText: "Launch plan" }).count()) === 1, "favorited");
    // Bob expands the parent so he can watch the sub-page come and go
    await B.locator("[data-testid=tree-row]", { hasText: "Launch plan" }).locator(".tree-toggle").click();
    await until(async () => (await B.locator("[data-testid=tree-row]", { hasText: "Sub page" }).count()) === 1, "Bob sees the sub-page");
    // trash + restore
    const sub = A.locator("[data-testid=tree-row]", { hasText: "Sub page" });
    await sub.hover();
    await sub.locator("[data-testid=tree-more]").click();
    await A.click("[data-testid=tree-delete]");
    await until(async () => (await B.locator("[data-testid=tree-row]", { hasText: "Sub page" }).count()) === 0, "trashed at Bob");
    await until(async () => (await A.locator(".leaf-editor .page-link", { hasText: "Sub page" }).count()) === 0, "link block removed");
    await A.click("[data-testid=open-trash]");
    await A.locator("[data-testid=trash-item]", { hasText: "Sub page" }).locator("[data-testid=trash-restore]").click();
    await A.keyboard.press("Escape");
    await until(async () => (await B.locator("[data-testid=tree-row]", { hasText: "Sub page" }).count()) === 1, "restored at Bob");
  });

  await test("sidebar drag and drop moves a page under another page", async () => {
    const src = A.locator("[data-testid=tree-row]", { hasText: "Launch plan" });
    const dst = A.locator("[data-testid=tree-row]", { hasText: "Engineering Wiki" });
    await drag(A, src, dst);
    await until(async () => {
      const r = await A.request.get(`${WEB}/api/pages/${await src.getAttribute("data-page-id")}`);
      const body = await r.json();
      return body.breadcrumbs.map((c) => c.title).join("/") === "Engineering Wiki/Launch plan";
    }, "moved under Engineering Wiki");
  });

  await test("database: table edits sync; board view groups by status", async () => {
    await openPage(A, "Product Roadmap");
    await openPage(B, "Product Roadmap");
    await A.waitForSelector("[data-testid=db-table]");
    await shot(A, "database-table");
    // Edit a title cell
    const title = A.locator("[data-testid=row-title]").first();
    await title.click();
    await title.fill("Offline editing v2");
    await title.press("Enter");
    await until(async () => (await B.locator("[data-testid=row-title]").first().inputValue()) === "Offline editing v2", "title cell at Bob");
    // Add a row
    await A.click("[data-testid=db-new]");
    await until(async () => (await B.locator("[data-testid=db-row]").count()) === 7, "new row at Bob");
    // Board view + move a card by changing its status
    await B.click("[data-testid=view-board]");
    await B.waitForSelector("[data-testid=db-board]");
    await shot(B, "database-board");
    const doneBefore = await B.locator('[data-testid="board-col-Done"] [data-testid=board-card]').count();
    await B.locator('[data-testid="board-col-Done"]').scrollIntoViewIfNeeded();
    const card = B.locator('[data-testid="board-col-In progress"] [data-testid=board-card]').first();
    await drag(B, card, B.locator('[data-testid="board-col-Done"]'));
    await until(async () => (await B.locator('[data-testid="board-col-Done"] [data-testid=board-card]').count()) === doneBefore + 1, "card moved to Done");
    await A.click("[data-testid=view-board]");
    await until(async () => (await A.locator('[data-testid="board-col-Done"] [data-testid=board-card]').count()) === doneBefore + 1, "Alice sees the move");
    await A.click("[data-testid=view-table]");
    await B.click("[data-testid=view-table]");
  });

  await test("database: filter and sort", async () => {
    await A.click("[data-testid=db-filter]");
    await A.click("[data-testid=add-filter]");
    const val = A.locator("[data-testid=filter-value]");
    await val.fill("search");
    await val.press("Enter");
    await until(async () => (await A.locator("[data-testid=db-row]").count()) === 1, "filtered to 1 row");
    await until(async () => (await B.locator("[data-testid=db-row]").count()) === 1, "filter is part of the shared view");
    await A.locator("[data-testid=filter-rule] .icon-btn").click();
    await until(async () => (await A.locator("[data-testid=db-row]").count()) === 7, "filter removed");
    await A.keyboard.press("Escape");
    await A.click("[data-testid=db-sort]");
    await A.click("[data-testid=add-sort]"); // defaults to the Points number column, ascending
    await A.keyboard.press("Escape");
    await until(async () => {
      const titles = await A.locator("[data-testid=row-title]").evaluateAll((els) => els.map((e) => e.value));
      return titles[0] === "Search ranking"; // 2 points: the smallest
    }, "sorted by points");
  });

  await test("database: add a property and set a select value", async () => {
    await A.click("[data-testid=db-add-prop]");
    await A.click("[data-testid=add-prop-select]");
    await until(async () => (await B.locator(".db-table th", { hasText: "Select" }).count()) === 1, "new column at Bob");
    const row = A.locator("[data-testid=db-row]").first();
    await row.locator(".cell-select .cell-tags").last().click();
    await A.locator("[data-testid=select-pop] input").fill("Q1");
    await A.locator("[data-testid=select-pop] input").press("Enter");
    await until(async () => (await B.locator("[data-testid=db-row]").first().locator(".tag", { hasText: "Q1" }).count()) === 1, "select value at Bob");
  });

  await test("open a database row as a page with its properties", async () => {
    await A.locator("[data-testid=db-row]").first().hover();
    await A.locator("[data-testid=row-open]").first().click();
    await A.waitForSelector("[data-testid=row-props]");
    await A.locator(".leaf-editor > p").last().click();
    await A.keyboard.type("Notes inside a row page");
    await shot(A, "row-page");
    await A.goBack();
    await A.waitForSelector("[data-testid=db-table]");
  });

  await test("database: relation, rollup and formula update live for everyone", async () => {
    await gotoPage(A, "Sprints");
    await gotoPage(B, "Sprints");
    await A.waitForSelector("[data-testid=db-table]");
    const row = (p, i) => p.locator("[data-testid=db-row]").nth(i);
    // Sprint 44 rolls up Snapshot compaction (3) + Search ranking (2).
    await until(async () => (await row(B, 2).locator(".cell-computed").first().innerText()) === "5", "initial rollup");
    await row(A, 2).locator("[data-testid=relate-items]").click();
    await A.waitForSelector("[data-testid=relation-pop]");
    await A.locator("[data-testid=relation-option]", { hasText: "Slash command menu" }).click();
    await A.keyboard.press("Escape");
    await until(async () => (await row(B, 2).locator(".cell-computed").first().innerText()) === "8", "sum rollup updates at Bob");
    await until(async () => (await row(B, 2).locator(".cell-computed").nth(1).innerText()) === "33.3%", "percent checked updates");
    // A formula over a rollup, added through the UI with a live preview.
    await A.click("[data-testid=db-add-prop]");
    await A.click("[data-testid=add-prop-formula]");
    await A.fill("[data-testid=formula-input]", 'prop("Points") * 10');
    await until(async () => (await A.locator("[data-testid=formula-preview]").innerText()).includes("Sprint 42 → 80"), "formula preview");
    await A.click("[data-testid=config-done]");
    await until(async () => (await row(B, 0).locator(".cell-computed").last().innerText()) === "80", "formula column at Bob");
    await shot(A, "database-relations");
    // The two-way relation shows the sprint on the roadmap side too.
    await openPage(A, "Product Roadmap");
    await until(async () => (await A.locator(".relation-chip", { hasText: "Sprint 44" }).count()) === 3, "mirror relation on the roadmap");
  });

  await test("database: calendar and gallery views", async () => {
    await openPage(A, "Product Roadmap");
    await openPage(B, "Product Roadmap");
    await A.click("[data-testid=view-calendar]");
    await B.click("[data-testid=view-calendar]");
    await A.waitForSelector("[data-testid=db-calendar]");
    await until(async () => (await A.locator("[data-testid=calendar-item]").count()) >= 3, "rows on the calendar");
    await shot(A, "database-calendar");
    const item = A.locator("[data-testid=calendar-item]").first();
    const title = (await item.innerText()).trim();
    const target = await A.evaluate(() => {
      const d = new Date();
      d.setDate(d.getDate() + 2);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    });
    // Both ends of a mouse drag must be on screen.
    await A.locator("[data-testid=db-calendar]").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await sleep(150);
    await drag(A, item, A.locator(`[data-day="${target}"]`));
    await until(async () => (await B.locator(`[data-day="${target}"] [data-testid=calendar-item]`, { hasText: title }).count()) === 1, "Bob sees the row on its new date");
    await A.click("[data-testid=view-gallery]");
    await until(async () => (await A.locator("[data-testid=gallery-card]").count()) >= 6, "gallery cards");
    await shot(A, "database-gallery");
    await A.click("[data-testid=view-table]");
    await B.click("[data-testid=view-table]");
  });

  await test("comments: thread on a block, reply, resolve", async () => {
    await openPage(A, "Scratchpad");
    await openPage(B, "Scratchpad");
    const block = A.locator(".leaf-editor > p", { hasText: "A blank-ish page" });
    await block.hover();
    await A.click("[data-testid=block-grip]");
    await A.click("[data-testid=block-comment]");
    await A.fill("[data-testid=comment-input]", "Can we expand this?");
    await A.click("[data-testid=comment-send]");
    await B.click("[data-testid=comments-btn]");
    await until(async () => (await B.locator("[data-testid=comment-thread]", { hasText: "Can we expand this?" }).count()) === 1, "Bob sees the thread");
    await B.locator("[data-testid=comment-thread] .reply input").fill("On it");
    await B.locator("[data-testid=comment-thread] .reply input").press("Enter");
    await until(async () => (await A.locator("[data-testid=comment-thread]", { hasText: "On it" }).count()) === 1, "Alice sees the reply");
    await until(async () => (await A.locator(".leaf-editor .has-comment").count()) >= 1, "commented block highlighted");
    await shot(A, "comments");
    await A.click("[data-testid=comment-resolve]");
    await until(async () => (await B.locator("[data-testid=comment-thread]").count()) === 0, "resolved for Bob");
    await A.click("[data-testid=comments-btn]");
    await B.click("[data-testid=comments-btn]");
  });

  await test("Cmd+K quick find searches content and navigates", async () => {
    await A.keyboard.press(`${MOD}+k`);
    await A.waitForSelector("[data-testid=quickfind]");
    await A.fill("[data-testid=quickfind-input]", "prototype drag");
    await until(async () => (await A.locator("[data-testid=quickfind-result]").first().innerText()).includes("Oct 21 sync"), "result");
    await shot(A, "quickfind");
    await A.keyboard.press("Enter");
    await until(async () => (await A.locator(".leaf-editor .page-title").innerText()) === "Oct 21 sync", "navigated");
  });

  await test("version history: save, edit, restore", async () => {
    await A.click("[data-testid=history-btn]");
    await A.click("[data-testid=save-version]");
    await until(async () => (await A.locator("[data-testid=version-item]").count()) >= 1, "version listed");
    await A.keyboard.press("Escape");
    await A.locator(".leaf-editor h2", { hasText: "Decisions" }).click();
    await A.keyboard.press("End");
    await A.keyboard.type(" (temporary edit)");
    await until(async () => (await editorText(A)).includes("temporary edit"), "edited");
    await sleep(400);
    await A.click("[data-testid=history-btn]");
    await A.locator("[data-testid=version-item]").first().click();
    await shot(A, "history");
    await A.click("[data-testid=restore-version]");
    await until(async () => !(await editorText(A)).includes("temporary edit"), "restored");
  });

  let shareUrl = "";
  await test("share link: anonymous visitor gets a read-only live view", async () => {
    await A.click("[data-testid=share-btn]");
    await A.locator("[data-testid=share-menu] .switch").click();
    shareUrl = await A.locator("[data-testid=share-link]").inputValue();
    await shot(A, "share");
    await A.keyboard.press("Escape");
    const ctxG = await browser.newContext();
    const G = await ctxG.newPage();
    await G.goto(shareUrl);
    await G.waitForSelector("[data-testid=editor]");
    assert((await G.locator(".leaf-editor").getAttribute("contenteditable")) === "false", "read only");
    assert((await G.locator("[data-testid=sidebar]").count()) === 0, "no sidebar for guests");
    await caretToEnd(A);
    await A.keyboard.press("Enter");
    await A.keyboard.type("Live for guests too");
    await until(async () => (await G.locator(".leaf-editor").innerText()).includes("Live for guests too"), "guest sees live edit");
    await ctxG.close();
  });

  await test("dark mode toggle", async () => {
    await A.click("[data-testid=theme-toggle]");
    assert((await A.evaluate(() => document.documentElement.dataset.theme)) === "dark", "dark");
    await openPage(A, "Welcome to Leaf");
    await shot(A, "dark");
    await A.click("[data-testid=theme-toggle]");
  });

  await test("synced block: an edit on one page shows on the other", async () => {
    await openPage(A, "Welcome to Leaf");
    await openPage(B, "Product Roadmap");
    const synced = (p) => p.locator("[data-testid=synced-editor]", { hasText: "Launch status" });
    await synced(A).waitFor();
    await synced(B).waitFor();
    await synced(A).locator(".callout-text").click();
    await A.keyboard.press("End");
    await A.keyboard.type(" EDITED-ON-WELCOME");
    await until(async () => (await synced(B).innerText()).includes("EDITED-ON-WELCOME"), "Bob sees the edit on the roadmap page");
    await B.locator("[data-testid=synced-block]").first().hover();
    await until(async () => (await B.locator("[data-testid=synced-tag]").first().innerText()).includes("Editing in 2 pages"), "label counts both pages");
    await shot(B, "synced-block");
    // It reaches the block table and search under both pages.
    await until(async () => {
      const ws = A.url().split("/w/")[1].split("/")[0];
      const { results } = await (await A.request.get(`${WEB}/api/workspaces/${ws}/search?q=EDITED-ON-WELCOME`)).json();
      const titles = results.map((r) => r.title);
      return titles.includes("Welcome to Leaf") && titles.includes("Product Roadmap");
    }, "search finds the synced text on both pages");
  });

  await test("guest sandbox: try Leaf without an account, invite a second person, edit together", async () => {
    const ctx1 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx1.grantPermissions(["clipboard-read", "clipboard-write"]);
    const G1 = await ctx1.newPage();
    await G1.goto(`${WEB}/login`);
    await G1.click("[data-testid=try-leaf]");
    await G1.waitForSelector("[data-testid=editor]", { timeout: 60_000 });
    await G1.waitForSelector("[data-testid=sandbox-banner]");
    await shot(G1, "sandbox");
    await G1.click("[data-testid=invite-btn]");
    const link = await G1.locator("[data-testid=invite-link]").inputValue();
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const G2 = await ctx2.newPage();
    await G2.goto(link);
    await G2.waitForSelector("[data-testid=editor]", { timeout: 60_000 });
    await openPage(G1, "Scratchpad");
    await openPage(G2, "Scratchpad");
    await caretToEnd(G1);
    await G1.keyboard.press("Enter");
    await G1.keyboard.type("Hello from a guest");
    await until(async () => (await editorText(G2)).includes("Hello from a guest"), "second guest sees the edit live");
    await until(async () => (await G2.locator("[data-testid=presence] .avatar").count()) >= 1, "guests see each other");
    // The sandbox is private: it isn't Alice's workspace.
    const ws = G1.url().split("/w/")[1].split("/")[0];
    assert((await A.request.get(`${WEB}/api/workspaces/${ws}/pages`)).status() === 403, "Alice can't read a guest sandbox");
    await ctx1.close();
    await ctx2.close();
  });

  await test("offline mode: cold reload, open an unvisited page, edit, then sync", async () => {
    const ctxO = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const goOffline = async () => {
      await ctxO.setOffline(true);
      await ctxO.route("**", (r) => r.abort("internetdisconnected"));
    };
    const goOnline = async () => {
      await ctxO.unrouteAll({ behavior: "ignoreErrors" });
      await ctxO.setOffline(false);
    };
    try {
      const O = await login(ctxO, "alice");
      const ws = O.url().split("/w/")[1].split("/")[0];
      const { blocks } = await (await O.request.get(`${WEB}/api/workspaces/${ws}/pages`)).json();
      const arch = blocks.find((b) => b.type === "page" && b.properties.title === "Architecture" && !b.archived);
      // The service worker takes control, and the background download finishes.
      await until(() => O.evaluate(() => !!navigator.serviceWorker.controller), "service worker controls the page", 20_000);
      await until(() => O.evaluate(() => window.__leafWarm && !window.__leafWarm.running && window.__leafWarm.total > 0), "pages saved for offline", 60_000);
      const saved = await O.evaluate(() => JSON.parse(localStorage.getItem("leaf:offline") ?? "{}"));
      assert(saved[arch.id], "Architecture (never opened) was downloaded");

      await goOffline();
      // A cold reload with no network: shell from the service worker, content from IndexedDB.
      await O.reload();
      await O.waitForSelector("[data-testid=editor]", { timeout: 20_000 });
      await until(async () => (await O.locator("[data-testid=offline-status]").innerText()).includes("on this device"), "sidebar says offline");
      // Open a page this tab has never displayed.
      await O.evaluate((id) => window.dispatchEvent(new CustomEvent("leaf-navigate", { detail: id })), arch.id);
      await until(async () => (await O.locator(".leaf-editor .page-title").innerText()).trim() === "Architecture", "Architecture opens offline", 20_000);
      assert((await editorText(O)).includes("Offline edits merge on reconnect"), "content came from the local replica");
      await caretToEnd(O);
      await O.keyboard.press("Enter");
      await O.keyboard.type("Written on a plane");
      await until(async () => /change.*saved on this device/.test(await O.locator("[data-testid=offline-pill]").innerText()), "pill counts offline changes");
      await shot(O, "offline-mode");
      // Survives another reload while still offline.
      await sleep(300);
      await O.reload();
      await O.waitForSelector("[data-testid=editor]", { timeout: 20_000 });
      await until(async () => (await editorText(O)).includes("Written on a plane"), "offline edit persisted locally");

      // Bob, online, hasn't seen it. Then Alice reconnects and it merges.
      await gotoPage(B, "Architecture");
      await caretToEnd(B);
      await B.keyboard.press("Enter");
      await B.keyboard.type("Bob was online");
      assert(!(await editorText(B)).includes("Written on a plane"), "not synced while offline");
      await goOnline();
      await until(async () => (await editorText(B)).includes("Written on a plane"), "Bob receives the offline edit", 30_000).catch(async (e) => {
        const dbg = await B.evaluate((id) => ({ ...window.__leafSync.debug(), count: window.__leafSyncCount, inRecords: window.__leafDocJSON(id).includes("plane") }), arch.id);
        throw new Error(`${e.message}\n    Bob sees: ${(await editorText(B)).slice(-120)}\n    Bob sync: ${JSON.stringify(dbg)}`);
      });
      await until(async () => (await editorText(O)).includes("Bob was online"), "Alice receives Bob's edit", 30_000);
      await until(async () => (await docXml(O)) === (await docXml(B)), "documents converge");
      await until(async () => (await O.locator("[data-testid=synced-pill]").count()) === 1, "synced confirmation");
    } finally {
      await goOnline().catch(() => {});
      await ctxO.close();
    }
  });

  await test("sign up a new user, who is denied a workspace they are not in", async () => {
    const ctxC = await browser.newContext();
    const C = await ctxC.newPage();
    await C.goto(`${WEB}/login`);
    await C.getByText("No account? Sign up").click();
    await C.fill("[data-testid=auth-name]", "Carol Test");
    await C.fill("[data-testid=auth-email]", "carol@e2e.test");
    await C.fill("[data-testid=auth-password]", "secret123");
    await C.click("[data-testid=auth-submit]");
    await C.waitForSelector("[data-testid=editor]");
    assert((await C.locator(".leaf-editor .page-title").innerText()) === "Getting started", "personal workspace");
    const r = await C.request.get(`${WEB}/api/pages/${A.url().split("/").pop()}`);
    assert(r.status() === 403, `expected 403, got ${r.status()}`);
    await ctxC.close();
  });

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} e2e checks passed${passed === results.length ? "" : ` · logs in ${tmp}`}\n`);
  if (KEEP) {
    console.log(`Servers still running: ${WEB}  (Ctrl+C to stop)`);
    await new Promise(() => {});
  }
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
