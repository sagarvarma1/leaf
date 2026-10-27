/** Records and text instances held in memory: the browser's view, and tests. */
import type { Block } from "../types.js";
import { applyOp, deriveText, type Applied, type RecordOp, type SyncState } from "./records.js";
import { TextInstance } from "./text.js";

export class MemoryState implements SyncState {
  readonly blocks: Map<string, Block>;
  readonly instances: Map<string, TextInstance>;
  private byInstance = new Map<string, Set<string>>();
  userId: string | null;

  constructor(opts: { userId?: string | null; blocks?: Map<string, Block>; instances?: Map<string, TextInstance> } = {}) {
    this.userId = opts.userId ?? null;
    this.blocks = opts.blocks ?? new Map();
    this.instances = opts.instances ?? new Map();
    for (const b of this.blocks.values()) this.index(b, true);
  }

  now() {
    return Date.now();
  }

  getBlock(id: string) {
    return this.blocks.get(id);
  }

  putBlock(b: Block) {
    const old = this.blocks.get(b.id);
    if (old) this.index(old, false);
    this.blocks.set(b.id, b);
    this.index(b, true);
  }

  private index(b: Block, on: boolean) {
    for (const s of b.text ?? []) {
      let set = this.byInstance.get(s.i);
      if (!set) this.byInstance.set(s.i, (set = new Set()));
      if (on) set.add(b.id);
      else set.delete(b.id);
    }
  }

  instance(id: string): TextInstance {
    let t = this.instances.get(id);
    if (!t) this.instances.set(id, (t = new TextInstance(id)));
    return t;
  }

  blocksOfInstance(id: string): string[] {
    return [...(this.byInstance.get(id) ?? [])];
  }

  findContainer(id: string): string | null {
    for (const b of this.blocks.values()) if (!b.archived && b.content.includes(id)) return b.id;
    return null;
  }

  /** Apply an op and refresh the derived text properties of the blocks it touched. */
  apply(op: RecordOp): Applied {
    const res = applyOp(this, op);
    for (const id of res.text) {
      const b = this.blocks.get(id);
      if (b) {
        const next = deriveText(this, b);
        if (next !== b) {
          this.putBlock(next);
          res.changed.add(id);
        }
      }
    }
    return res;
  }

  /** A copy of the records sharing the same text instances (CRDTs merge, records rebase). */
  fork(): MemoryState {
    return new MemoryState({ userId: this.userId, blocks: new Map(this.blocks), instances: this.instances });
  }
}
