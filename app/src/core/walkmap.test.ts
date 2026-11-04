import { describe, expect, it } from "vitest";
import { buildSegments, leftNormals, resample } from "./geom";
import type { EN } from "./proj";
import type { Judgment } from "./types";
import { checkRows, fitFrame, rowChunks, walkMapPageCount, type WalkMapInput } from "./walkmap";

describe("持って歩く地図：表に出す区切り", () => {
  const dense = resample([[0, 0], [40, 0]] as EN[], 1);
  const segs = buildSegments(dense, leftNormals(dense), { step: 10, roadHalf: 3, bandOut: 10 });
  const j = (segmentId: string, patch: Partial<Judgment> = {}): Judgment => ({ segmentId, tree: 50, kind: "広葉樹", other: [], conf: "中", why: "理由", by: "Claude", ...patch });
  const base = (judgments: Map<string, Judgment>, notes: Map<string, { segmentId: string; result: "○" | "△" | "×" | ""; memo: string; at: string }>, unjudged?: Set<string>): WalkMapInput => ({
    title: "t", roadName: "r", dense, normals: leftNormals(dense), segments: segs, parcels: [], hits: [], judgments, kps: [], sweep: null, outer: null, tiltZones: [], trackText: "", withPhoto: false, forest: null, forestFlags: null, notes, unjudged,
  });

  it("確かめる所に加えて、現地の記録（○△×・メモ）のある区切りも入る。未判定も入る。起点から順", () => {
    const judgments = new Map<string, Judgment>([["L000", j("L000", { conf: "低" })], ["R000", j("R000", { conf: "高", tree: 100 })], ["L002", j("L002")]]);
    const notes = new Map([
      ["R000", { segmentId: "R000", result: "×" as const, memo: "電線", at: "" }], // 確信「高」だが記録あり → 入る
      ["L002", { segmentId: "L002", result: "" as const, memo: "", at: "" }], // 空の記録 → 入らない
    ]);
    const rows = checkRows(base(judgments, notes, new Set(["R002"])), segs);
    expect(rows.map((r) => `${r.id}:${r.kind}`)).toEqual(["L000:低", "R000:記録", "R002:未判定"]);
    expect(rows[1].why).toBe("判定：100%（Claude）");
    expect(rows[2].tree).toBeNull();
  });

  it("確かめる所に記録があっても、行は 1 つ（記録の行を重ねない）", () => {
    const judgments = new Map<string, Judgment>([["L000", j("L000", { conf: "低" })]]);
    const notes = new Map([["L000", { segmentId: "L000", result: "○" as const, memo: "", at: "" }]]);
    expect(checkRows(base(judgments, notes), segs).map((r) => r.kind)).toEqual(["低"]);
  });
});

describe("持って歩く地図：枠に収める", () => {
  it("横長の範囲は幅で縮尺が決まり、上下に余りが出て真ん中に置かれる", () => {
    const box = { x: 10, y: 10, w: 100, h: 100 }; // mm → 800×800 px
    const f = fitFrame(box, [0, 0, 400, 100], 36.6);
    expect(f.scale).toBe(2); // 800 / 400
    expect(f.minX).toBe(0);
    expect(f.minY).toBe(-150); // 高さ 400 px 分の内、範囲 100 の余り 300 の半分
    expect(f.metersPerPagePx).toBeGreaterThan(0);
  });
  it("縦長の範囲は高さで決まる", () => {
    const f = fitFrame({ x: 0, y: 0, w: 100, h: 50 }, [0, 0, 100, 400], 36.6);
    expect(f.scale).toBe(1); // 400 / 400
    expect(f.minX).toBe(-350);
  });
});

describe("持って歩く地図：表の行が多いとき（Codex の指摘 2026-11-04：表が 310mm になり地図の枠が潰れた）", () => {
  it("14 行までは地図のページ、残りは 30 行ずつ続きのページ", () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => i);
    expect(rowChunks(n(0)).map((c) => c.length)).toEqual([0]);
    expect(rowChunks(n(14)).map((c) => c.length)).toEqual([14]);
    expect(rowChunks(n(40)).map((c) => c.length)).toEqual([14, 26]);
    expect(rowChunks(n(50)).map((c) => c.length)).toEqual([14, 30, 6]);
  });
  it("200m の全区切り（40）に記録があると、ページは 索引 1 ＋ 地図 1 ＋ 続き 1", () => {
    const dense = resample([[0, 0], [200, 0]] as EN[], 1);
    const normals = leftNormals(dense);
    const segs = buildSegments(dense, normals, { step: 10, roadHalf: 3, bandOut: 10 });
    expect(segs.length).toBe(40);
    const notes = new Map(segs.map((s) => [s.id, { segmentId: s.id, result: "○" as const, memo: "", at: "" }]));
    const input: WalkMapInput = {
      title: "t", roadName: "r", dense, normals, segments: segs, parcels: [], hits: [], judgments: new Map(), kps: [], sweep: null, outer: null, tiltZones: [], trackText: "", withPhoto: false, forest: null, forestFlags: null, notes,
    };
    expect(walkMapPageCount(input)).toBe(3);
    expect(walkMapPageCount({ ...input, notes: new Map() })).toBe(2);
  });
});
