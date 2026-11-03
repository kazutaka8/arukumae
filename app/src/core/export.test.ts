import { describe, expect, it } from "vitest";
import { buildRows, COLUMNS, toCsv } from "./export";
import type { Judgment, ParcelHit, ParcelProps } from "./types";

const hit: ParcelHit = {
  parcelId: "m:1",
  areaM2: 150,
  fromM: 320,
  toM: 360,
  sides: ["L"],
  segmentIds: ["L032", "L033", "L034", "L035"],
  segAreas: { L032: 40, L033: 50, L034: 30, L035: 30 },
  shape: { type: "MultiPolygon", coordinates: [] },
};
const parcels = new Map<string, { properties: ParcelProps }>([["m:1", { properties: { id: "m:1", map: "m", oaza: "大字稲丘", chiban: "2303-1", kind: "ふつう" } }]]);
const j = (segmentId: string, tree: number, conf: Judgment["conf"], by: Judgment["by"] = "Claude", kind: Judgment["kind"] = "広葉樹"): Judgment => ({
  segmentId, tree, conf, by, kind, other: ["草地"], why: `理由 ${segmentId}`,
});

describe("buildRows", () => {
  it("筆ごとに集計する：木の面積は区切りの面積×割合の合計、確信はいちばん低いもの、低の区切りが確かめる所", () => {
    const judgments = new Map([
      ["L032", j("L032", 100, "高")],
      ["L033", j("L033", 50, "中", "Claude", "針葉樹")],
      ["L034", j("L034", 0, "低", "Claude", "なし")],
      // L035 は未判定
    ]);
    const [r] = buildRows([hit], parcels, judgments, [{ atM: 100, kp: 12 }, { atM: 600, kp: 12.5 }], "小川長野線");
    expect(r.起点からの距離).toBe("320〜360m");
    expect(r.左右).toBe("左");
    expect(r.道路名とKP).toBe("小川長野線 12.24km 付近（推定）"); // 340m → 12 + 0.5×240/500
    expect(r.KPの根拠).toBe("距離標 12.00〜12.50 から補間");
    expect(r.所在).toBe("大字稲丘");
    expect(r.地番).toBe("2303-1");
    expect(r.かかる面積m2).toBe(150);
    expect(r.木のある面積m2).toBe(65); // 40×1 + 50×0.5 + 30×0
    expect(r.樹種の目安).toBe("広葉樹 1・針葉樹 1"); // 「なし」は数えない
    expect(r.確信).toBe("低");
    expect(r.現地で確かめる所).toBe("L034：理由 L034");
    expect(r.決めたのは).toBe("Claude");
    expect(r.森林の区域).toBe(""); // 森林のデータをまだ読めていない
  });

  it("森林の区域を渡すと、列に言葉と届出の目印が入る", () => {
    const forest = new Map([["m:1", { ratio: 0.8, kinds: ["民有林" as const], rinpan: ["0058"] }]]);
    const [r] = buildRows([hit], parcels, new Map(), [], "x", forest);
    expect(r.森林の区域).toBe("民有林（林班 0058）");
    expect(r.伐採の届出の目印).toBe("要るかもしれない（市町村に確かめる）");
    expect(buildRows([hit], parcels, new Map(), [], "x", new Map())[0].森林の区域).toBe("区域外"); // 読めたが重ならない
  });

  it("距離標が足りないときは KP を空にして理由を書く。判定がなければ木の列は空", () => {
    const [r] = buildRows([hit], parcels, new Map(), [], "小川長野線");
    expect(r.道路名とKP).toBe("");
    expect(r.KPの根拠).toBe("距離標が 2 本未満");
    expect(r.木のある面積m2).toBe("");
    expect(r.決めたのは).toBe("");
  });

  it("未判定（答えに番号がなかった区切り）も「現地で確かめる所」に出す（画面・KML・PDF と同じ並び）", async () => {
    const { buildSegments, leftNormals, resample } = await import("./geom");
    const dense = resample([[0, 0], [400, 0]] as [number, number][], 1);
    const segs = buildSegments(dense, leftNormals(dense), { step: 10, roadHalf: 3, bandOut: 10 });
    const judgments = new Map([["L032", j("L032", 100, "高")]]);
    const [r] = buildRows([hit], parcels, judgments, [], "x", null, null, segs, null, new Set(["L033"]));
    expect(r.現地で確かめる所).toContain("L033（未判定）");
  });

  it("人が直した区切りが混じると「人・Claude」", () => {
    const judgments = new Map([["L032", j("L032", 100, "高", "人")], ["L033", j("L033", 50, "中")]]);
    expect(buildRows([hit], parcels, judgments, [], "x")[0].決めたのは).toBe("人・Claude");
  });
});

describe("toCsv", () => {
  it("BOM 付き、列はそろい、カンマと引用符と改行を囲む", () => {
    const judgments = new Map([["L032", { ...j("L032", 25, "低"), why: '影が多く、"迷う"' }]]);
    const csv = toCsv(buildRows([hit], parcels, judgments, [], "小川長野線"));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(COLUMNS.join(","));
    expect(lines[1]).toContain('"L032：影が多く、""迷う"""');
    expect(lines[1].split(",").length).toBeGreaterThanOrEqual(COLUMNS.length);
  });
});

describe("公図を買うリスト", () => {
  it("所在・地番が同じ行は 1 つにまとめ、面積を足す。列は買う控えに要るものだけ", async () => {
    const { buildBuyList, toBuyCsv, BUY_COLUMNS } = await import("./export");
    const rows = buildRows([hit, { ...hit, areaM2: 20, fromM: 400, toM: 410 }], parcels, new Map(), [], "小川長野線");
    const buy = buildBuyList(rows);
    expect(buy.length).toBe(1);
    expect(buy[0].所在).toBe("大字稲丘");
    expect(buy[0].地番).toBe("2303-1");
    expect(buy[0].かかる面積m2).toBe(170);
    expect(buy[0].起点からの距離).toBe("320〜360m"); // 先に出た行の場所
    const csv = toBuyCsv(buy);
    expect(csv.startsWith("﻿" + BUY_COLUMNS.join(","))).toBe(true);
    expect(csv).toContain("大字稲丘,2303-1,一般,320〜360m,左,,170,,,");
  });
});

describe("現地の記録の列", () => {
  it("筆にかかる区切りの○△×とメモを 1 つにまとめる。記録を渡さなければ空", () => {
    const notes = new Map([["L033", { segmentId: "L033", result: "×" as const, memo: "電線あり", at: "2026-11-03T01:00:00Z" }], ["L035", { segmentId: "L035", result: "○" as const, memo: "", at: "2026-11-03T01:00:00Z" }]]);
    const [r] = buildRows([hit], parcels, new Map(), [], "小川長野線", null, null, [], notes);
    expect(r.現地の記録).toBe("L033 ×：電線あり ／ L035 ○");
    expect(buildRows([hit], parcels, new Map(), [], "小川長野線")[0].現地の記録).toBe("");
    expect(COLUMNS).toContain("現地の記録");
  });
});
