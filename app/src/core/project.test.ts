import { describe, expect, it } from "vitest";
import { buildProject, describeProject, mojAttribution, parseProject, projectFileName, PROJECT_VERSION, type ProjectFile } from "./project";
import { toPlaneZone } from "./proj";
import { DEFAULT_TRACK } from "./trackstate";
import { PRESETS } from "./vehicle";

const DEMO = { coords: [[137.991895, 36.644648], [137.98698, 36.650153]] as [number, number][], roadName: "小川長野線" };

function made(): ProjectFile {
  return buildProject(
    {
      name: "小川村 県道401号（見本）",
      roadName: "小川長野線",
      centerline: { coords: DEMO.coords, source: { kind: "demo" } },
      zone: 8,
      track: DEFAULT_TRACK,
      parcels: null,
      judgments: [{ segmentId: "L001", tree: 75, kind: "広葉樹", other: [], conf: "低", why: "影", by: "Claude", model: "claude-sonnet-5-5" }],
      kps: [{ atM: 0, kp: 12 }],
      notes: [{ segmentId: "L001", result: "×", memo: "電線", at: "2026-11-03T00:00:00Z" }],
      unjudged: ["R003"],
    },
    new Date("2026-11-03T09:30:00Z"),
  );
}

describe("案件ファイル", () => {
  it("書いたものをそのまま読み戻せる", () => {
    const p = parseProject(JSON.stringify(made()), DEMO);
    expect(p.app).toBe("arukumae");
    expect(p.version).toBe(PROJECT_VERSION);
    expect(p.savedAt).toBe("2026-11-03T09:30:00.000Z");
    expect(p.name).toBe("小川村 県道401号（見本）");
    expect(p.track).toEqual(DEFAULT_TRACK);
    expect(p.parcels).toBeNull();
    expect(p.centerline).toEqual({ coords: DEMO.coords, source: { kind: "demo" } });
    expect(p.zone).toBe(8);
    expect(p.judgments).toHaveLength(1);
    expect(p.kps).toEqual([{ atM: 0, kp: 12 }]);
    expect(p.notes[0].memo).toBe("電線");
    expect(p.unjudged).toEqual(["R003"]);
    expect(describeProject(p)).toBe("小川村 県道401号（見本）（2026-11-03 09:30 保存）：中心線 見本（小川村 県道401号）・公図は見本・判定 1・距離標 1・現地の記録 1");
  });

  it("中心線の出どころ（KML・手描き・OSM）も読み戻せる", () => {
    const kml = { ...made(), centerline: { coords: DEMO.coords, source: { kind: "kml", file: "軌跡図.kml", line: "中心線" } }, roadName: "県道999号", zone: 10 };
    const p = parseProject(JSON.stringify(kml), DEMO);
    expect(p.centerline.source).toEqual({ kind: "kml", file: "軌跡図.kml", line: "中心線" });
    expect(p.zone).toBe(10);
    expect(describeProject(p)).toContain("軌跡図「軌跡図.kml」の線「中心線」");
    expect(describeProject(p)).toContain("公図はまだ");
    const osm = { ...made(), centerline: { coords: DEMO.coords, source: { kind: "osm", wayIds: [1, 2], fetchedAt: "2026-11-03" } } };
    expect(parseProject(JSON.stringify(osm), DEMO).centerline.source).toEqual({ kind: "osm", wayIds: [1, 2], fetchedAt: "2026-11-03" });
    expect(parseProject(JSON.stringify({ ...made(), centerline: { coords: DEMO.coords, source: { kind: "drawn" } } }), DEMO).centerline.source).toEqual({ kind: "drawn" });
  });

  it("版 1（見本の区間に固定）は、見本の中心線を補って読む。軌跡図の線は第VIII系の平面座標から緯度経度にする", () => {
    const en = toPlaneZone(8, [137.99, 36.645]);
    const v1 = { ...made(), version: 1, roadName: "小川長野線", track: { ...DEFAULT_TRACK, source: { kind: "file", name: "a.kml", lines: [[en, en]] } } };
    delete (v1 as { centerline?: unknown }).centerline;
    delete (v1 as { zone?: unknown }).zone;
    const p = parseProject(JSON.stringify(v1), DEMO);
    expect(p.centerline.source).toEqual({ kind: "demo" });
    expect(p.zone).toBe(8);
    expect(p.version).toBe(PROJECT_VERSION);
    const line = (p.track.source as { lines: [number, number][][] }).lines[0][0];
    expect(Math.abs(line[0] - 137.99)).toBeLessThan(1e-7);
    expect(Math.abs(line[1] - 36.645)).toBeLessThan(1e-7);
    expect(() => parseProject(JSON.stringify({ ...v1, roadName: "別の道" }), DEMO)).toThrow(/見本の区間/);
  });

  it("公図の筆が入っていれば持ち回る。空なら見本扱い（null）。出典の表記は地図の市区町村名から", () => {
    const feature = { type: "Feature", properties: { id: "m:1", map: "m", oaza: null, chiban: "1", kind: "ふつう" }, geometry: { type: "Polygon", coordinates: [[[138, 36.6], [138.001, 36.6], [138.001, 36.601], [138, 36.6]]] } };
    const maps = [{ stem: "m", name: "x", city: "上水内郡小川村", crs: "公共座標8系", isPublic: true, total: 1, kept: 1, noShape: 0 }];
    const withParcels = { ...made(), parcels: { fileName: "ogawa.zip", maps, skipped: [], features: [feature], sources: [{ city: "小川村", code: "20588", zip: "20588-1000-2026.zip", datasetUrl: "https://x", fetchedAt: "2026-11-03" }] } };
    const p = parseProject(JSON.stringify(withParcels), DEMO);
    expect(p.parcels?.features).toHaveLength(1);
    expect(p.parcels?.sources?.[0].code).toBe("20588");
    expect(mojAttribution(p.parcels, false)).toBe("登記所備付地図データ 上水内郡小川村（法務省）");
    expect(mojAttribution(null, true)).toBe("登記所備付地図データ 上水内郡小川村（法務省）");
    expect(mojAttribution(null, false)).toBe("登記所備付地図データ（法務省）");
    const empty = { ...made(), parcels: { fileName: "ogawa.zip", maps: [], skipped: [], features: [] } };
    expect(parseProject(JSON.stringify(empty), DEMO).parcels).toBeNull();
  });

  it("選択肢にない値が 1 つでもあれば、ファイル全体を断る（細工されたファイルから HTML を通さない）", () => {
    const base = made();
    const j = base.judgments[0];
    const bad = (patch: object, re: RegExp) => expect(() => parseProject(JSON.stringify({ ...base, judgments: [{ ...j, ...patch }] }), DEMO)).toThrow(re);
    bad({ kind: "<img src=x onerror=alert(1)>" }, /樹種/);
    bad({ conf: "とても高い" }, /確信/);
    bad({ tree: 30 }, /木の割合/);
    bad({ other: ["<b>"] }, /木以外/);
    bad({ by: "Codex" }, /決めたのは/);
    bad({ segmentId: "<script>" }, /区切りの番号/);
    bad({ change: "<x>" }, /変化/);
    bad({ oldYear: "20xx" }, /4 桁/);
    bad({ before: { tree: 1, conf: "高" } }, /最初の判定/);
    bad({ prev: { ...j, kind: "<x>" } }, /樹種/);
    expect(() => parseProject(JSON.stringify({ ...base, notes: [{ segmentId: "L001", result: "<x>" }] }), DEMO)).toThrow(/○△×/);
    expect(() => parseProject(JSON.stringify({ ...base, unjudged: ["<x>"] }), DEMO)).toThrow(/未判定/);
    expect(() => parseProject(JSON.stringify({ ...base, kps: [{ atM: "a", kp: 1 }] }), DEMO)).toThrow(/距離標/);
    const feature = { type: "Feature", properties: { id: "m:1", map: "m", oaza: null, chiban: "1", kind: "宅地" }, geometry: { type: "Polygon", coordinates: [[[138, 36.6], [138.001, 36.6], [138.001, 36.601], [138, 36.6]]] } };
    expect(() => parseProject(JSON.stringify({ ...base, parcels: { fileName: "a", maps: [], skipped: [], features: [feature] } }), DEMO)).toThrow(/種類/);
    const badGeom = { ...feature, properties: { ...feature.properties, kind: "ふつう" }, geometry: { type: "Polygon", coordinates: [[[138, "x"], [1, 1], [2, 2], [138, 36.6]]] } };
    expect(() => parseProject(JSON.stringify({ ...base, parcels: { fileName: "a", maps: [], skipped: [], features: [badGeom] } }), DEMO)).toThrow(/多角形/);
    // 自由な文（理由・メモ）はそのまま通す（画面に出すときに escapeHtml する）
    const ok = parseProject(JSON.stringify({ ...base, judgments: [{ ...j, why: "<b>影</b>" }] }), DEMO);
    expect(ok.judgments[0].why).toBe("<b>影</b>");
  });

  it("別のファイル・新しい版・壊れた形は、日本語の理由で断る", () => {
    const base = made();
    expect(() => parseProject("not json", DEMO)).toThrow(/JSON として読めません/);
    expect(() => parseProject(JSON.stringify({ type: "FeatureCollection", features: [] }), DEMO)).toThrow(/案件ファイルではない/);
    expect(() => parseProject(JSON.stringify({ ...base, version: PROJECT_VERSION + 1 }), DEMO)).toThrow(/新しい版/);
    expect(() => parseProject(JSON.stringify({ ...base, track: null }), DEMO)).toThrow(/track/);
    expect(() => parseProject(JSON.stringify({ ...base, track: { source: { kind: "vehicle", preset: "rocket" }, band: {} } }), DEMO)).toThrow(/知らない車両/);
    expect(() => parseProject(JSON.stringify({ ...base, judgments: "x" }), DEMO)).toThrow(/judgments が配列/);
    expect(() => parseProject(JSON.stringify({ ...base, centerline: { coords: [[1, 1]], source: { kind: "demo" } } }), DEMO)).toThrow(/中心線/);
    expect(() => parseProject(JSON.stringify({ ...base, zone: 20 }), DEMO)).toThrow(/系/);
    expect(() => parseProject(JSON.stringify({ ...base, track: { ...DEFAULT_TRACK, band: { ...DEFAULT_TRACK.band, cut: "3" } } }), DEMO)).toThrow(/余裕幅/);
  });

  it("ファイル名は案件名の記号を置き換える", () => {
    expect(projectFileName("小川村 県道401号（見本）", "2026-11-03")).toBe("arukumae_小川村_県道401号（見本）_2026-11-03.json");
    expect(projectFileName("a/b:c", "2026-11-03")).toBe("arukumae_a_b_c_2026-11-03.json");
    expect(projectFileName("", "2026-11-03")).toBe("arukumae_案件_2026-11-03.json");
  });
});

describe("長い道の案件（起点から 10km を超えると区切りの番号が 4 桁になる）", () => {
  it("L1000 のような番号の判定・記録・未判定を読める（Claude の独立レビュー 2026-11-03）", () => {
    const p = { ...made(), judgments: [{ ...made().judgments[0], segmentId: "L1000" }], notes: [{ segmentId: "R1234", result: "○", memo: "", at: "" }], unjudged: ["L999", "R1000"] };
    const r = parseProject(JSON.stringify(p), DEMO);
    expect(r.judgments[0].segmentId).toBe("L1000");
    expect(r.notes[0].segmentId).toBe("R1234");
    expect(r.unjudged).toEqual(["L999", "R1000"]);
    expect(() => parseProject(JSON.stringify({ ...p, unjudged: ["L12"] }), DEMO)).toThrow(/未判定/);
  });
});

describe("伐採範囲の決め方の数（Codex の指摘 2026-11-04：文字が入ると画面に HTML として出た）", () => {
  const base = made();
  const withSource = (source: object) => JSON.stringify({ ...base, track: { ...base.track, source } });
  it("起立の区間に数でない値や範囲の外があれば断る", () => {
    expect(() => parseProject(withSource({ kind: "vehicle", preset: "lifter", tiltZones: [{ fromM: 100000, toM: 100010, tilt: "<img src=x onerror=alert(1)>" }] }), DEMO)).toThrow(/起立の区間/);
    expect(() => parseProject(withSource({ kind: "vehicle", preset: "lifter", tiltZones: [{ fromM: 20, toM: 10, tilt: 60 }] }), DEMO)).toThrow(/起立の区間/);
    expect(() => parseProject(withSource({ kind: "vehicle", preset: "lifter", tiltZones: "<x>" }), DEMO)).not.toThrow(); // 配列でなければ空にする（前からの扱い）
  });
  it("車両の寸法に文字があれば断り、無ければ型の値で埋める。知らない項目は落とす", () => {
    expect(() => parseProject(withSource({ kind: "vehicle", preset: "lifter", vehicle: { tractorWidth: "<x>" } }), DEMO)).toThrow(/車両の寸法/);
    const p = parseProject(withSource({ kind: "vehicle", preset: "lifter", tiltZones: [], vehicle: { tractorWidth: 3, extra: "<x>" } }), DEMO);
    if (p.track.source.kind !== "vehicle") throw new Error("vehicle のはず");
    expect(p.track.source.vehicle.tractorWidth).toBe(3);
    expect(p.track.source.vehicle.tractorWheelbase).toBe(PRESETS.lifter.vehicle.tractorWheelbase);
    expect("extra" in p.track.source.vehicle).toBe(false);
  });
  it("伸縮トレーラーの標準値（bladeRootAt が負）はそのまま通る", () => {
    const p = parseProject(withSource({ kind: "vehicle", preset: "extendable", tiltZones: [], vehicle: PRESETS.extendable.vehicle }), DEMO);
    if (p.track.source.kind !== "vehicle") throw new Error("vehicle のはず");
    expect(p.track.source.vehicle.bladeRootAt).toBe(-3);
  });
  it("仮の帯の幅が数でなければ断る", () => {
    expect(() => parseProject(withSource({ kind: "band", halfWidth: "13" }), DEMO)).toThrow(/仮の帯/);
    expect(parseProject(withSource({ kind: "band", halfWidth: 13 }), DEMO).track.source.kind).toBe("band");
  });
});
