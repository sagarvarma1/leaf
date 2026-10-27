import { describe, expect, it } from "vitest";
import { loadTest } from "../bench/load.js";

describe("load", () => {
  it("20 people typing on one page at once all converge", async () => {
    const r = await loadTest(20, 15);
    expect(r.commits).toBe(300);
  }, 60_000);
});
