import { describe, expect, it } from "vitest";
import { newerOf } from "./store";

describe("置き場の新旧（Codex の指摘 2026-11-04：IndexedDB に書けず localStorage に落とした次の起動で古いほうに戻った）", () => {
  const old = { savedAt: "2026-11-03T00:00:00.000Z" };
  const latest = { savedAt: "2026-11-04T00:00:00.000Z" };
  it("両方にあれば savedAt が新しいほう。片方だけならそれ。どちらも無ければ null", () => {
    expect(newerOf(old, latest)).toBe(latest);
    expect(newerOf(latest, old)).toBe(latest);
    expect(newerOf(null, old)).toBe(old);
    expect(newerOf(old, null)).toBe(old);
    expect(newerOf(null, null)).toBeNull();
  });
  it("savedAt の無いものより、あるものを取る。同じなら先の引数（IndexedDB）", () => {
    expect(newerOf({}, old)).toBe(old);
    expect(newerOf(old, {})).toBe(old);
    const same = { savedAt: old.savedAt };
    expect(newerOf(old, same)).toBe(old);
  });
});
