import { describe, expect, it } from "vitest";
import { buildProject, describeProject, parseProject, projectFileName, PROJECT_VERSION } from "./project";
import { DEFAULT_TRACK } from "./trackstate";

describe("案件ファイル", () => {
  const made = buildProject(
    {
      name: "小川村 県道401号（見本）",
      roadName: "小川長野線",
      track: DEFAULT_TRACK,
      parcels: null,
      judgments: [{ segmentId: "L001", tree: 75, kind: "広葉樹", other: [], conf: "低", why: "影", by: "Claude", model: "claude-sonnet-5-5" }],
      kps: [{ atM: 0, kp: 12 }],
      notes: [{ segmentId: "L001", result: "×", memo: "電線", at: "2026-11-03T00:00:00Z" }],
    },
    new Date("2026-11-03T09:30:00Z"),
  );

  it("書いたものをそのまま読み戻せる", () => {
    const p = parseProject(JSON.stringify(made));
    expect(p.app).toBe("arukumae");
    expect(p.version).toBe(PROJECT_VERSION);
    expect(p.savedAt).toBe("2026-11-03T09:30:00.000Z");
    expect(p.name).toBe("小川村 県道401号（見本）");
    expect(p.track).toEqual(DEFAULT_TRACK);
    expect(p.parcels).toBeNull();
    expect(p.judgments).toHaveLength(1);
    expect(p.kps).toEqual([{ atM: 0, kp: 12 }]);
    expect(p.notes[0].memo).toBe("電線");
    expect(describeProject(p)).toBe("小川村 県道401号（見本）（2026-11-03 09:30 保存）：公図は見本・判定 1・距離標 1・現地の記録 1");
  });

  it("公図の筆が入っていれば持ち回る。空なら見本扱い（null）", () => {
    const feature = { type: "Feature", properties: { id: "m:1", map: "m", oaza: null, chiban: "1", kind: "ふつう" }, geometry: { type: "Polygon", coordinates: [[[138, 36.6], [138.001, 36.6], [138.001, 36.601], [138, 36.6]]] } };
    const withParcels = { ...made, parcels: { fileName: "ogawa.zip", maps: [], skipped: [], features: [feature] } };
    expect(parseProject(JSON.stringify(withParcels)).parcels?.features).toHaveLength(1);
    const empty = { ...made, parcels: { fileName: "ogawa.zip", maps: [], skipped: [], features: [] } };
    expect(parseProject(JSON.stringify(empty)).parcels).toBeNull();
  });

  it("壊れた行は落とし、無い配列は空にする", () => {
    const p = parseProject(JSON.stringify({ ...made, judgments: [{ segmentId: "L001" }, { segmentId: "L002", tree: 25 }], kps: undefined, notes: [1] }));
    expect(p.judgments.map((j) => j.segmentId)).toEqual(["L002"]);
    expect(p.kps).toEqual([]);
    expect(p.notes).toEqual([]);
  });

  it("別のファイルや新しい版は、日本語の理由で断る", () => {
    expect(() => parseProject("not json")).toThrow(/JSON として読めません/);
    expect(() => parseProject(JSON.stringify({ type: "FeatureCollection", features: [] }))).toThrow(/案件ファイルではない/);
    expect(() => parseProject(JSON.stringify({ ...made, version: PROJECT_VERSION + 1 }))).toThrow(/新しい版/);
    expect(() => parseProject(JSON.stringify({ ...made, track: null }))).toThrow(/track/);
    expect(() => parseProject(JSON.stringify({ ...made, track: { source: { kind: "vehicle", preset: "rocket" }, band: {} } }))).toThrow(/知らない車両/);
    expect(() => parseProject(JSON.stringify({ ...made, judgments: "x" }))).toThrow(/judgments が配列/);
  });

  it("ファイル名は案件名の記号を置き換える", () => {
    expect(projectFileName("小川村 県道401号（見本）", "2026-11-03")).toBe("arukumae_小川村_県道401号（見本）_2026-11-03.json");
    expect(projectFileName("a/b:c", "2026-11-03")).toBe("arukumae_a_b_c_2026-11-03.json");
    expect(projectFileName("", "2026-11-03")).toBe("arukumae_案件_2026-11-03.json");
  });
});
