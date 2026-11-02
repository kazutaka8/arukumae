import { describe, expect, it } from "vitest";
import type { Check } from "./checks";
import { filterChecks, filterHits, type HitFilterContext } from "./filter";
import type { FieldNote } from "./notes";
import type { Judgment, ParcelHit, ParcelProps } from "./types";

const hit = (parcelId: string, segmentIds: string[]): ParcelHit => ({ parcelId, areaM2: 10, fromM: 0, toM: 10, sides: ["L"], segmentIds, segAreas: {}, shape: { type: "MultiPolygon", coordinates: [] } });
const j = (segmentId: string, tree: number, conf: Judgment["conf"] = "高"): [string, Judgment] => [segmentId, { segmentId, tree, conf, kind: "広葉樹", other: [], why: "", by: "Claude" }];
const note = (segmentId: string, result: FieldNote["result"]): [string, FieldNote] => [segmentId, { segmentId, result, memo: "", at: "" }];

const hits = [hit("m:1", ["L001", "L002"]), hit("m:2", ["L003"]), hit("m:3", ["L004"]), hit("m:4", ["R001"])];
const ctx: HitFilterContext = {
  parcelById: new Map<string, { properties: ParcelProps }>([
    ["m:1", { properties: { id: "m:1", map: "m", oaza: "大字稲丘", chiban: "2303-1", kind: "ふつう" } }],
    ["m:2", { properties: { id: "m:2", map: "m", oaza: "大字稲丘", chiban: "2304", kind: "ふつう" } }],
    ["m:3", { properties: { id: "m:3", map: "m", oaza: "大字高府", chiban: "15-3", kind: "道" } }],
    ["m:4", { properties: { id: "m:4", map: "m", oaza: null, chiban: "99", kind: "ふつう" } }],
  ]),
  judgments: new Map([j("L001", 25, "低"), j("L002", 75), j("L003", 0), j("L004", 50)]),
  checkSegs: new Set(["L001"]),
  forest: new Map([["m:2", { ratio: 0.9, kinds: ["民有林"], rinpan: [] }], ["m:3", { ratio: 0.01, kinds: [], rinpan: [] }]]),
  notes: new Map([note("L003", "×"), note("L004", "○")]),
};
const ids = (xs: ParcelHit[]) => xs.map((h) => h.parcelId);

describe("かかる筆の絞り込み", () => {
  it("種類ごと", () => {
    expect(ids(filterHits(hits, "all", "", ctx))).toEqual(["m:1", "m:2", "m:3", "m:4"]);
    expect(ids(filterHits(hits, "tree", "", ctx))).toEqual(["m:1", "m:3"]); // 最大 75・50。m:2 は 0、m:4 は未判定
    expect(ids(filterHits(hits, "check", "", ctx))).toEqual(["m:1"]);
    expect(ids(filterHits(hits, "forest", "", ctx))).toEqual(["m:2"]); // 1% は「外」
    expect(ids(filterHits(hits, "unjudged", "", ctx))).toEqual(["m:4"]);
    expect(ids(filterHits(hits, "ng", "", ctx))).toEqual(["m:2"]);
  });

  it("地番と所在の文字で探す。種類と重ねられる", () => {
    expect(ids(filterHits(hits, "all", "2303", ctx))).toEqual(["m:1"]);
    expect(ids(filterHits(hits, "all", " 高府 ", ctx))).toEqual(["m:3"]);
    expect(ids(filterHits(hits, "tree", "230", ctx))).toEqual(["m:1"]);
    expect(ids(filterHits(hits, "all", "ない", ctx))).toEqual([]);
  });
});

describe("確かめる所の絞り込み", () => {
  const checks: Check[] = [
    { segmentId: "L001", kind: "低", why: "影", tree: 25 },
    { segmentId: "L003", kind: "森林", why: "区域の中なのに 0%", tree: 0 },
    { segmentId: "L004", kind: "低", why: "ぼやけ", tree: 50 },
  ];
  it("種類と現地の記録で絞る", () => {
    const seg = (xs: Check[]) => xs.map((c) => c.segmentId);
    expect(seg(filterChecks(checks, "all", ctx.notes))).toEqual(["L001", "L003", "L004"]);
    expect(seg(filterChecks(checks, "low", ctx.notes))).toEqual(["L001", "L004"]);
    expect(seg(filterChecks(checks, "forest", ctx.notes))).toEqual(["L003"]);
    expect(seg(filterChecks(checks, "todo", ctx.notes))).toEqual(["L001"]);
    expect(seg(filterChecks(checks, "ng", ctx.notes))).toEqual(["L003"]);
    expect(seg(filterChecks(checks, "done", ctx.notes))).toEqual(["L003", "L004"]);
  });
});
