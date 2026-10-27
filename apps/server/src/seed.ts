import { defaultDatabase, isoDay, type BlockInput, type DatabaseProperties, type RichText } from "@leaf/shared";
import { AI_USER } from "./ai/agent.js";
import type { Leaf } from "./app.js";

export const DEMO_PASSWORD = "leafdemo";
export const DEMO_USERS = [
  { email: "alice@leaf.dev", name: "Alice Chen" },
  { email: "bob@leaf.dev", name: "Bob Rivera" },
];

const t = (text: string, marks?: RichText[number]["marks"]): RichText[number] => (marks ? { text, marks } : { text });
const p = (...runs: Array<RichText[number] | string>): BlockInput => ({
  type: "paragraph",
  properties: { rich_text: runs.map((r) => (typeof r === "string" ? t(r) : r)) },
});
const h = (level: 1 | 2 | 3, text: string): BlockInput => ({ type: `heading_${level}`, properties: { rich_text: [t(text)] } });
const todo = (text: string, checked = false): BlockInput => ({ type: "to_do", properties: { rich_text: [t(text)], checked } });
const bullet = (text: string, children?: BlockInput[]): BlockInput => ({ type: "bulleted_list_item", properties: { rich_text: [t(text)] }, children });
const num = (text: string): BlockInput => ({ type: "numbered_list_item", properties: { rich_text: [t(text)] } });
/** A date relative to when the demo is seeded, so the calendar and "days left" stay current. */
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return isoDay(d);
};

/** Seed two demo users sharing one workspace full of sample pages. Idempotent. */
export function seed(leaf: Leaf) {
  // The Leaf AI system user always exists; seed only when there are no real users yet.
  const existing = leaf.db.prepare("SELECT COUNT(*) AS n FROM users WHERE id != ?").get(AI_USER.id) as { n: number };
  if (existing.n > 0) return false;

  const [alice, bob] = DEMO_USERS.map((u) => leaf.signup(u.email, u.name, DEMO_PASSWORD));
  const ws = leaf.createWorkspace("Acme Product", alice!.id, "🌿");
  leaf.addMember(ws, bob!.email);
  seedDemoContent(leaf, ws, alice!.id, bob!.id);
  return true;
}

/**
 * The demo workspace's pages, database, synced block, comments and history. Used for the
 * seeded Alice/Bob workspace and for every guest sandbox (where A is the guest).
 */
export function seedDemoContent(leaf: Leaf, ws: string, A: string, B: string) {

  // ---- Welcome
  const welcome = leaf.createPage({
    workspaceId: ws,
    userId: A,
    title: "Welcome to Leaf",
    icon: "👋",
    cover: "gradient-1",
    content: [
      { type: "callout", properties: { icon: "🌿", rich_text: [t("Leaf is a small Notion rebuilt from scratch: every page is a tree of blocks, edited together in real time.")] } },
      h(1, "Try it"),
      p("Type ", t("/", { code: true }), " for the block menu, or use markdown: ", t("# ", { code: true }), ", ", t("- ", { code: true }), ", ", t("[] ", { code: true }), ", ", t("> ", { code: true }), ", ", t("```", { code: true }), "."),
      p("Select text for the ", t("formatting toolbar", { bold: true }), ": ", t("bold", { bold: true }), ", ", t("italic", { italic: true }), ", ", t("underline", { underline: true }), ", ", t("strike", { strike: true }), ", ", t("code", { code: true }), ", ", t("links", { link: "https://www.notion.so" }), " and ", t("colors", { color: "#d9730d" }), "."),
      { type: "paragraph", properties: { rich_text: [t("Mention people like "), { text: "@Bob Rivera", mention: { type: "user", id: B } }, t(" with @, and drag the ⋮⋮ handle to reorder blocks.")] } },
      todo("Open this page in a second window as another person (Bob, or in a sandbox: Invite a collaborator in the sidebar)", true),
      todo("Type in both windows at once and watch the cursors"),
      todo("Click ✨ AI in the top bar and ask Leaf AI to summarize this page"),
      todo("Press Cmd/Ctrl+K to search"),
      { type: "toggle", properties: { rich_text: [t("How does sync work?")], open: false }, children: [
        p("Like Notion: blocks are records, and every edit is a transaction of operations. Your browser applies it at once, queues it, and the server orders it and sends it to everyone else."),
        bullet("Text inside a block: a CRDT (RGA + Peritext), so concurrent typing always converges"),
        bullet("Structure (moving, nesting, deleting blocks): ordered by the server"),
        bullet("Enter and Backspace move slices of shared text, so nobody's typing gets lost"),
      ] },
      { type: "quote", properties: { rich_text: [t("The best way to understand a tool is to rebuild it.")] } },
      { type: "divider" },
      { type: "image", properties: { url: "https://picsum.photos/seed/leaf-notion/1200/420", caption: "Image blocks take any URL" } },
    ],
  });

  // ---- Roadmap with an inline database
  const roadmap = leaf.createPage({
    workspaceId: ws,
    userId: A,
    title: "Product Roadmap",
    icon: "🚀",
    cover: "gradient-3",
    content: [
      p("Our plan for Q4. The database below is a real block: rows are pages, and edits sync to everyone."),
      h(2, "Q4 initiatives"),
    ],
  });
  const db: DatabaseProperties = defaultDatabase("Q4 Roadmap");
  db.schema.priority = {
    id: "priority",
    name: "Priority",
    type: "select",
    options: [
      { id: "p0", name: "P0", color: "red" },
      { id: "p1", name: "P1", color: "orange" },
      { id: "p2", name: "P2", color: "gray" },
    ],
  };
  db.schema.owner = { id: "owner", name: "Owner", type: "person" };
  db.schema.due = { id: "due", name: "Due", type: "date" };
  db.schema.points = { id: "points", name: "Points", type: "number" };
  db.schema.tags = {
    id: "tags",
    name: "Tags",
    type: "multi_select",
    options: [
      { id: "editor", name: "Editor", color: "blue" },
      { id: "sync", name: "Sync", color: "purple" },
      { id: "infra", name: "Infra", color: "brown" },
      { id: "growth", name: "Growth", color: "green" },
    ],
  };
  db.schema.shipped = { id: "shipped", name: "Shipped", type: "checkbox" };
  db.order = ["title", "status", "priority", "owner", "due", "points", "tags", "shipped"];
  db.views[0]!.sorts = [];
  db.schema.left = {
    id: "left",
    name: "Days left",
    type: "formula",
    formula: {
      expression: 'if(prop("Shipped"), "✅ Shipped", if(empty(prop("Due")), "", if(dateBetween(prop("Due"), today(), "days") < 0, "⚠️ Overdue", format(dateBetween(prop("Due"), today(), "days")) + " days left")))',
    },
  };
  db.order.push("left");
  db.views.push(
    { id: "calendar", name: "Calendar", type: "calendar", sorts: [], filters: [], dateProperty: "due" },
    { id: "gallery", name: "Gallery", type: "gallery", sorts: [], filters: [], cardPreview: "cover" },
  );
  const roadmapDb = leaf.createDatabase({
    pageId: roadmap.id,
    userId: A,
    append: true,
    database: db,
    rows: [
      { title: "Offline editing", values: { status: "doing", priority: "p0", owner: A, due: day(12), points: 8, tags: ["sync"] } },
      { title: "Slash command menu", values: { status: "done", priority: "p1", owner: B, due: day(-9), points: 3, tags: ["editor"], shipped: true } },
      { title: "Board view drag and drop", values: { status: "doing", priority: "p1", owner: B, due: day(7), points: 5, tags: ["editor"] } },
      { title: "Snapshot compaction", values: { status: "todo", priority: "p2", owner: A, due: day(26), points: 3, tags: ["infra", "sync"] } },
      { title: "Public share links", values: { status: "done", priority: "p0", owner: A, due: day(-15), points: 5, tags: ["growth"], shipped: true } },
      { title: "Search ranking", values: { status: "todo", priority: "p2", owner: B, points: 2, tags: ["infra"] } },
    ],
  });
  leaf.appendChildren(roadmap.id, A, [p("Switch to the Board view to drag cards between statuses, or Calendar to move due dates.")]);
  // Covers for the gallery view.
  roadmapDb.content.forEach((rowId, i) => leaf.updatePage(rowId, A, { cover: `gradient-${(i % 6) + 1}` }));

  // ---- Sprints: a second database related to the roadmap, with rollups over it.
  const sprintsPage = leaf.createPage({
    parentId: roadmap.id,
    userId: A,
    title: "Sprints",
    icon: "🏃",
    content: [p("Each sprint links roadmap items through a two-way relation. Points and progress are rollups over the linked items.")],
  });
  const sprints = leaf.createDatabase({
    pageId: sprintsPage.id,
    userId: A,
    append: true,
    title: "Sprints",
    rows: [
      { title: "Sprint 42", values: { status: "done" } },
      { title: "Sprint 43", values: { status: "doing" } },
      { title: "Sprint 44", values: { status: "todo" } },
    ],
  });
  const items = Object.fromEntries(roadmapDb.content.map((id) => [leaf.store.get(id)!.properties.title, id]));
  leaf.applyDatabaseOp(sprints.id, A, { op: "addProperty", id: "items", name: "Roadmap items", type: "relation", relation: { databaseId: roadmapDb.id }, twoWay: true });
  leaf.applyDatabaseOp(sprints.id, A, { op: "addProperty", id: "points", name: "Points", type: "rollup", rollup: { relationPropertyId: "items", targetPropertyId: "points", function: "sum" } });
  leaf.applyDatabaseOp(sprints.id, A, { op: "addProperty", id: "progress", name: "Shipped", type: "rollup", rollup: { relationPropertyId: "items", targetPropertyId: "shipped", function: "percent_checked" } });
  leaf.applyDatabaseOp(sprints.id, A, { op: "addProperty", id: "health", name: "Health", type: "formula", formula: { expression: 'if(prop("Points") > 10, "🔥 Heavy", "🙂 OK")' } });
  const [s42, s43, s44] = leaf.store.get(sprints.id)!.content;
  leaf.setRowValues(s42!, A, { items: [items["Slash command menu"], items["Public share links"]] });
  leaf.setRowValues(s43!, A, { items: [items["Offline editing"], items["Board view drag and drop"]] });
  leaf.setRowValues(s44!, A, { items: [items["Snapshot compaction"], items["Search ranking"]] });

  // ---- A synced block: one piece of content shown on the roadmap and the welcome page.
  const status = leaf.createSyncedBlock({
    pageId: roadmap.id,
    userId: A,
    content: [
      { type: "callout", properties: { icon: "🚦", rich_text: [t("Launch status: ", { bold: true }), t("beta ships Nov 14. This callout is a synced block, so editing it here changes it everywhere it appears.")] } },
      todo("Security review", true),
      todo("Pricing page"),
    ],
  });
  const synced: BlockInput = { type: "synced_block", properties: { synced_from: status.id } };
  const intro = leaf.pageBlocks(roadmap.id).page.content[0];
  leaf.appendChildren(roadmap.id, A, [synced], intro);

  // ---- Layout features on the welcome page: columns, children of any block, the synced block.
  const welcomeToggle = leaf.pageBlocks(welcome.id).blocks.find((b) => b.type === "toggle")?.id;
  leaf.appendChildren(
    welcome.id,
    A,
    [
      h(2, "Layouts"),
      {
        type: "column_list",
        children: [
          {
            type: "column",
            children: [
              h(3, "Columns"),
              p("Drag a block by its ⋮⋮ handle onto the left or right edge of another block to make columns. Drag the gap between columns to resize them."),
            ],
          },
          {
            type: "column",
            children: [
              h(3, "Nesting"),
              { ...p("Press Tab on any block to nest it under the block above, Shift+Tab to lift it out."), children: [p("Like this paragraph."), todo("Or this to-do")] },
            ],
          },
        ],
      },
      p("The status below is a ", t("synced block", { bold: true }), ": it also lives on the Product Roadmap page. Edit it in either place."),
      synced,
    ],
    welcomeToggle,
  );

  const notes = leaf.createPage({ parentId: roadmap.id, userId: A, title: "Meeting Notes", icon: "📝" });
  leaf.createPage({
    parentId: notes.id,
    userId: B,
    title: "Oct 21 sync",
    icon: "🗓️",
    content: [
      h(2, "Attendees"),
      { type: "paragraph", properties: { rich_text: [{ text: "@Alice Chen", mention: { type: "user", id: A } }, t(", "), { text: "@Bob Rivera", mention: { type: "user", id: B } }] } },
      h(2, "Decisions"),
      num("Ship offline editing behind a flag"),
      num("Board view gets drag and drop first"),
      h(2, "Action items"),
      todo("Alice: write the sync design doc", true),
      todo("Bob: prototype drag handle"),
    ],
  });

  // ---- Engineering wiki
  const wiki = leaf.createPage({
    workspaceId: ws,
    userId: B,
    title: "Engineering Wiki",
    icon: "📚",
    content: [p("Everything about how we build Leaf.")],
  });
  leaf.createPage({
    parentId: wiki.id,
    userId: B,
    title: "Architecture",
    icon: "🏗️",
    content: [
      h(1, "Block model"),
      p("Everything is a block with an id, a type, properties, a parent pointer and an ordered list of children."),
      { type: "code", properties: { language: "typescript", rich_text: [t(`interface Block {\n  id: string;\n  type: BlockType;\n  properties: Record<string, unknown>;\n  parent_id: string | null;\n  content: string[]; // ordered child ids\n}`)] } },
      h(2, "Sync"),
      bullet("Clients keep a record cache and a transaction queue", [bullet("Offline edits merge on reconnect")]),
      bullet("The server orders transactions, bumps record versions and broadcasts commits"),
      { type: "callout", properties: { icon: "⚠️", rich_text: [t("Only text is a CRDT. Structure and databases use server-ordered operations.")] } },
    ],
  });
  leaf.createPage({
    parentId: wiki.id,
    userId: B,
    title: "Onboarding",
    icon: "🎒",
    content: [todo("Get repo access", true), todo("Run pnpm dev"), todo("Ship a small fix in week one")],
  });

  // ---- Sandbox
  leaf.createPage({
    workspaceId: ws,
    userId: A,
    title: "Scratchpad",
    icon: "🧪",
    content: [p("A blank-ish page for the live demo. Type here from two windows at once.")],
  });

  // ---- favorites, comments, a saved version
  leaf.setFavorite(A, welcome.id, true);
  leaf.setFavorite(A, roadmap.id, true);
  leaf.setFavorite(B, roadmap.id, true);
  const { blocks } = leaf.pageBlocks(welcome.id);
  const quote = blocks.find((b) => b.type === "quote");
  const thread = leaf.addComment(welcome.id, B, { blockId: quote?.id ?? null, body: "Love this line. Should we put it on the landing page?" }) as any;
  leaf.addComment(welcome.id, A, { threadId: thread.id, body: "Yes! Adding it to the launch checklist." });
  leaf.sync.snapshot(welcome.id, A, "Initial version");
  leaf.sync.flush();
}
