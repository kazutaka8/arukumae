import { describe, expect, it } from "vitest";
import type { Segment } from "./geom";
import { windowsOf } from "./photo";

function fakeSegments(pairs: number): Segment[] {
  const out: Segment[] = [];
  for (let k = 0; k < pairs; k++) {
    for (const side of ["L", "R"] as const) {
      out.push({ id: `${side}${String(k).padStart(3, "0")}`, side, fromM: k * 10, toM: k * 10 + 10, ring: [], areaM2: 100 });
    }
  }
  return out;
}

describe("windowsOf", () => {
  it("145 対（1.45km）は 8 窓に均等に割れ、最後の窓だけ小さくならない", () => {
    const w = windowsOf(fakeSegments(145));
    expect(w).toHaveLength(8);
    expect(w.map((x) => x.length)).toEqual([38, 38, 38, 38, 38, 38, 38, 24]);
    expect(w.flat().map((s) => s.id)).toEqual(fakeSegments(145).map((s) => s.id)); // 順も漏れも変わらない
    for (const x of w) expect(x.length % 2).toBe(0); // 左右がそろう
  });

  it("20 対までなら 1 窓", () => {
    expect(windowsOf(fakeSegments(20))).toHaveLength(1);
    expect(windowsOf(fakeSegments(21))).toHaveLength(2);
  });
});
