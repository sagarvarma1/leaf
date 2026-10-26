import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  appendBlocks,
  deleteBlock,
  ensureBlockIds,
  getFragment,
  hasPageLink,
  hydrateFragment,
  projectFragment,
  removePageLinks,
  replaceFragment,
  setBlockText,
  setTitle,
  type BlockInput,
} from "../src/index.js";

const sample: BlockInput[] = [
  { id: "h", type: "heading_1", properties: { rich_text: [{ text: "Hello" }] } },
  {
    id: "p",
    type: "paragraph",
    properties: {
      rich_text: [
        { text: "bold", marks: { bold: true } },
        { text: " and " },
        { text: "link", marks: { link: "https://notion.so", color: "red" } },
        { text: "@Alice", mention: { type: "user", id: "u1" } },
      ],
    },
  },
  { id: "b1", type: "bulleted_list_item", properties: { rich_text: [{ text: "one" }] }, children: [
    { id: "b1a", type: "bulleted_list_item", properties: { rich_text: [{ text: "nested" }] } },
  ] },
  { id: "b2", type: "bulleted_list_item", properties: { rich_text: [{ text: "two" }] } },
  { id: "n1", type: "numbered_list_item", properties: { rich_text: [{ text: "first" }] } },
  { id: "t1", type: "to_do", properties: { rich_text: [{ text: "task" }], checked: true } },
  { id: "tg", type: "toggle", properties: { rich_text: [{ text: "More" }], open: false }, children: [
    { id: "inside", type: "paragraph", properties: { rich_text: [{ text: "hidden" }] } },
  ] },
  { id: "q", type: "quote", properties: { rich_text: [{ text: "quoted" }] } },
  { id: "c", type: "callout", properties: { rich_text: [{ text: "note" }], icon: "🔥" } },
  { id: "code", type: "code", properties: { rich_text: [{ text: "const a = 1;\nconsole.log(a)" }], language: "typescript" } },
  { id: "d", type: "divider" },
  { id: "img", type: "image", properties: { url: "https://x.test/a.png", caption: "cap" } },
  { id: "child", type: "child_page" },
  { id: "db", type: "child_database" },
  { id: "lnk", type: "link_to_page", properties: { page_id: "other" } },
];

function docWith(blocks = sample, title = "My page") {
  const doc = new Y.Doc();
  hydrateFragment(getFragment(doc), title, blocks);
  return doc;
}

describe("block model <-> collaborative document", () => {
  it("round-trips every block type through the Yjs document", () => {
    const doc = docWith();
    const proj = projectFragment(getFragment(doc), "page", { isChildPage: (id) => id === "child" });
    expect(proj.title).toBe("My page");
    expect(proj.content).toEqual(["h", "p", "b1", "b2", "n1", "t1", "tg", "q", "c", "code", "d", "img", "child", "db", "lnk"]);
    const byId = Object.fromEntries(proj.blocks.map((b) => [b.id, b]));
    expect(byId.h!.type).toBe("heading_1");
    expect(byId.p!.properties.rich_text).toEqual(sample[1]!.properties!.rich_text);
    expect(byId.b1!.content).toEqual(["b1a"]);
    expect(byId.b1a!.parent_id).toBe("b1");
    expect(byId.t1!.properties.checked).toBe(true);
    expect(byId.tg!.content).toEqual(["inside"]);
    expect(byId.tg!.properties.open).toBe(false);
    expect(byId.c!.properties.icon).toBe("🔥");
    expect(byId.code!.properties).toEqual({ rich_text: [{ text: "const a = 1;\nconsole.log(a)" }], language: "typescript" });
    expect(byId.img!.properties).toEqual({ url: "https://x.test/a.png", caption: "cap" });
    expect(byId.lnk!.type).toBe("link_to_page");
    expect(proj.childPages).toEqual(["child"]);
    expect(proj.databases).toEqual(["db"]);
    expect(proj.text).toContain("hidden");
  });

  it("a page link to a non-child page becomes link_to_page", () => {
    const proj = projectFragment(getFragment(docWith()), "page", { isChildPage: () => false });
    expect(proj.linkedPages).toEqual(["child", "other"]);
  });

  it("re-keys missing and duplicate block ids", () => {
    const doc = docWith([
      { id: "same", type: "paragraph" },
      { id: "same", type: "paragraph" },
    ]);
    const frag = getFragment(doc);
    (frag.get(1) as Y.XmlElement).removeAttribute("blockId");
    let fixed = 0;
    doc.transact(() => (fixed = ensureBlockIds(frag)));
    expect(fixed).toBeGreaterThanOrEqual(1);
    const ids = projectFragment(frag, "p").content;
    expect(new Set(ids).size).toBe(2);
    expect(ensureBlockIds(frag)).toBe(0);
  });

  it("server-side edits: title, append, delete, set text, page links", () => {
    const doc = docWith([{ id: "a", type: "paragraph", properties: { rich_text: [{ text: "A" }] } }]);
    const frag = getFragment(doc);
    doc.transact(() => {
      setTitle(frag, "Renamed");
      appendBlocks(frag, [{ id: "b", type: "to_do", properties: { rich_text: [{ text: "B" }] } }, { id: "kid", type: "child_page" }]);
      setBlockText(frag, "a", [{ text: "A2", marks: { italic: true } }]);
    });
    let proj = projectFragment(frag, "p", { isChildPage: () => true });
    expect(proj.title).toBe("Renamed");
    expect(proj.content).toEqual(["a", "b", "kid"]);
    expect(proj.blocks[0]!.properties.rich_text).toEqual([{ text: "A2", marks: { italic: true } }]);
    expect(hasPageLink(frag, "kid")).toBe(true);
    doc.transact(() => {
      removePageLinks(frag, "kid");
      deleteBlock(frag, "b");
    });
    proj = projectFragment(frag, "p");
    expect(proj.content).toEqual(["a"]);
  });

  it("replaceFragment restores a snapshot as a new change", () => {
    const a = docWith([{ id: "x", type: "paragraph", properties: { rich_text: [{ text: "v1" }] } }], "T");
    const snapshot = Y.encodeStateAsUpdate(a);
    a.transact(() => setBlockText(getFragment(a), "x", [{ text: "v2" }]));
    const old = new Y.Doc();
    Y.applyUpdate(old, snapshot);
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(a));
    a.on("update", (u: Uint8Array) => Y.applyUpdate(remote, u));
    a.transact(() => replaceFragment(getFragment(a), getFragment(old)));
    expect(projectFragment(getFragment(remote), "p").blocks[0]!.properties.rich_text).toEqual([{ text: "v1" }]);
  });

  it("concurrent edits on two replicas converge", () => {
    const a = docWith([{ id: "x", type: "paragraph", properties: { rich_text: [{ text: "Hello" }] } }]);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const ta = (getFragment(a).get(1) as Y.XmlElement).get(0) as Y.XmlText;
    const tb = (getFragment(b).get(1) as Y.XmlElement).get(0) as Y.XmlText;
    ta.insert(5, " world");
    tb.insert(0, ">> ");
    appendBlocks(getFragment(b), [{ id: "y", type: "paragraph", properties: { rich_text: [{ text: "B" }] } }]);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const pa = projectFragment(getFragment(a), "p");
    const pb = projectFragment(getFragment(b), "p");
    expect(pa).toEqual(pb);
    expect(pa.blocks[0]!.properties.rich_text[0].text).toBe(">> Hello world");
  });
});

describe("children of any block, columns and synced blocks", () => {
  const nested: BlockInput[] = [
    { id: "parent", type: "paragraph", properties: { rich_text: [{ text: "Parent" }] }, children: [
      { id: "kid1", type: "paragraph", properties: { rich_text: [{ text: "Kid one" }] } },
      { id: "kid2", type: "heading_2", properties: { rich_text: [{ text: "Kid two" }] }, children: [
        { id: "grandkid", type: "to_do", properties: { rich_text: [{ text: "Deep" }] } },
      ] },
    ] },
    { id: "cl", type: "column_list", children: [
      { id: "colA", type: "column", properties: { width: 2 }, children: [{ id: "a1", type: "paragraph", properties: { rich_text: [{ text: "Left" }] } }] },
      { id: "colB", type: "column", properties: { width: 1 }, children: [
        { id: "b1", type: "callout", properties: { rich_text: [{ text: "Right" }], icon: "🚀" }, children: [{ id: "b1kid", type: "paragraph", properties: { rich_text: [{ text: "Inside callout" }] } }] },
      ] },
    ] },
    { id: "sync1", type: "synced_block", properties: { synced_from: "container" } },
  ];

  it("round-trips nested blocks, columns and synced blocks", () => {
    const doc = docWith(nested);
    const proj = projectFragment(getFragment(doc), "page");
    const byId = Object.fromEntries(proj.blocks.map((b) => [b.id, b]));
    expect(proj.content).toEqual(["parent", "cl", "sync1"]);
    expect(byId.parent!.content).toEqual(["kid1", "kid2"]);
    expect(byId.kid2!.type).toBe("heading_2");
    expect(byId.kid2!.parent_id).toBe("parent");
    expect(byId.kid2!.content).toEqual(["grandkid"]);
    expect(byId.grandkid!.parent_id).toBe("kid2");
    expect(byId.cl!.type).toBe("column_list");
    expect(byId.cl!.content).toEqual(["colA", "colB"]);
    expect(byId.colA!.properties.width).toBe(2);
    expect(byId.colA!.content).toEqual(["a1"]);
    expect(byId.b1!.parent_id).toBe("colB");
    expect(byId.b1!.content).toEqual(["b1kid"]);
    expect(byId.sync1!.properties).toEqual({ synced_from: "container" });
    expect(proj.syncedBlocks).toEqual(["container"]);
    expect(proj.text).toContain("Inside callout");
  });

  it("projection is a fixed point: hydrate(project(doc)) projects identically", () => {
    const proj = projectFragment(getFragment(docWith(nested)), "page");
    const byId = new Map(proj.blocks.map((b) => [b.id, b]));
    const tree = (ids: string[]): BlockInput[] =>
      ids.map((id) => {
        const b = byId.get(id)!;
        return { id, type: b.type, properties: b.properties, children: tree(b.content) };
      });
    const again = projectFragment(getFragment(docWith(tree(proj.content))), "page");
    expect(again.blocks).toEqual(proj.blocks);
  });

  it("deleting the head of a nest deletes its children too", () => {
    const doc = docWith(nested);
    const frag = getFragment(doc);
    doc.transact(() => deleteBlock(frag, "parent"));
    const proj = projectFragment(frag, "page");
    expect(proj.content).toEqual(["cl", "sync1"]);
    expect(proj.blocks.find((b) => b.id === "kid1")).toBeUndefined();
  });

  it("appendBlocks can anchor after a nested block", () => {
    const doc = docWith(nested);
    const frag = getFragment(doc);
    doc.transact(() => appendBlocks(frag, [{ id: "after", type: "paragraph" }], "kid1"));
    expect(projectFragment(frag, "page").content).toEqual(["parent", "after", "cl", "sync1"]);
  });

  it("a container document has no title", () => {
    const doc = new Y.Doc();
    hydrateFragment(getFragment(doc), null, [{ id: "x", type: "paragraph", properties: { rich_text: [{ text: "shared" }] } }]);
    const proj = projectFragment(getFragment(doc), "container");
    expect(proj.title).toBe("");
    expect(proj.content).toEqual(["x"]);
  });
});
