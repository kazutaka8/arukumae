/**
 * 「伐採範囲をどう決めているか」の状態（手順 2）。3 つの出どころを同じ形（Sweep → 外側の距離）に落とす。
 * - vehicle：車両の寸法から計算した架空の軌跡図（vehicle.ts）
 * - file：読み込んだ軌跡図（KML・GeoJSON。track.ts）
 * - band：仮の帯（中心線から一定の幅）。軌跡図も車両もないときの代わり
 * この端末に残す（localStorage）。読んだ軌跡図の座標もこの端末の中だけ
 */
import { buildSegments, type Segment } from "./geom";
import { toLonLatZone, type EN, type LonLat } from "./proj";
import { linesToPlane, sweepFromLines } from "./track";
import { curveFlags, DEFAULT_BAND, flatSweep, outerFromSweep, PRESETS, sweepVehicle, type BandParams, type PresetId, type Sweep, type TiltZone, type Vehicle } from "./vehicle";

export type TrackSource =
  | { kind: "vehicle"; preset: PresetId; vehicle: Vehicle; tiltZones: TiltZone[] }
  /** 読んだ軌跡図の線（緯度経度。案件の系が変わっても使えるように平面座標では持たない。2026-11-03） */
  | { kind: "file"; name: string; lines: LonLat[][] }
  | { kind: "band"; halfWidth: number };

export interface TrackSetting {
  source: TrackSource;
  band: BandParams;
}

export interface TrackResult {
  sweep: Sweep;
  outer: { left: Float64Array; right: Float64Array };
  segments: Segment[];
}

export const DEFAULT_TRACK: TrackSetting = {
  source: { kind: "vehicle", preset: "lifter", vehicle: { ...PRESETS.lifter.vehicle }, tiltZones: [] },
  band: { ...DEFAULT_BAND },
};

/**
 * 計算と説明に使う起立の区間。立てられるのはブレードリフターだけで、伸縮トレーラーは水平のまま。
 * リフターで区間を決めたあと車両の型を伸縮トレーラーに替えると、区間が残ったまま 55m のブレードが半分の長さで計算され、
 * 編集の欄は隠れているので「水平」の表示のまま掃く範囲が狭く出た（拾う筆が漏れる側。Codex の指摘 2026-11-06）。
 * 画面と案件ファイルの読み込みでも区間を消すが、どこから来ても狭く出ないように計算の入口でも外す
 */
export function tiltZonesOf(s: TrackSource): TiltZone[] {
  return s.kind === "vehicle" && s.preset === "lifter" ? s.tiltZones : [];
}

export function computeTrack(dense: EN[], normals: EN[], t: TrackSetting): TrackResult {
  const curve = curveFlags(dense);
  let sweep: Sweep;
  switch (t.source.kind) {
    case "vehicle":
      sweep = sweepVehicle(dense, normals, t.source.vehicle, tiltZonesOf(t.source));
      break;
    case "file":
      sweep = sweepFromLines(dense, normals, linesToPlane(t.source.lines));
      break;
    case "band":
      // 仮の帯は「余裕幅＋伐採の幅」を含めた一定の幅にする。掃く範囲＝幅−（余裕＋伐採）と逆算すると直線とカーブで変わってしまうため
      sweep = flatSweep(dense.length, t.source.halfWidth);
      break;
  }
  const outer =
    t.source.kind === "band"
      ? { left: Float64Array.from(sweep.left), right: Float64Array.from(sweep.right) }
      : outerFromSweep(sweep, curve, t.band);
  const segments = buildSegments(dense, normals, { step: 10, roadHalf: t.band.roadHalf, bandOut: outer });
  return { sweep, outer, segments };
}

/** 画面と一覧表に出す、伐採範囲の決め方の短い説明 */
export function describeTrack(t: TrackSetting): string {
  const s = t.source;
  const tail = `＋余裕幅（直線 ${t.band.marginStraight}m・カーブ ${t.band.marginCurve}m）＋${t.band.cut}m`;
  switch (s.kind) {
    case "vehicle":
      return `架空の軌跡図（${PRESETS[s.preset].name}、ブレード ${s.vehicle.bladeLength}m${s.vehicle.tilt ? `・${s.vehicle.tilt}° に立てる` : "・寝かせる"}${tiltZonesOf(s).length ? `・起立の区間 ${tiltZonesOf(s).length}` : ""}）${tail}`;
    case "file":
      return `軌跡図「${s.name}」${tail}`;
    case "band":
      return `仮の帯：中心線から ${t.band.roadHalf}〜${s.halfWidth}m`;
  }
}

/** 古い保存（2026-11-03 までの localStorage の鍵。線は第VIII系の平面座標）を読む。案件の保存にまとめるときの 1 回だけ使う */
export function legacyTrack(raw: unknown): TrackSetting | null {
  try {
    const t = raw as TrackSetting;
    if (!t || !t.source || !t.band) return null;
    if (t.source.kind === "vehicle" && !(t.source.preset in PRESETS)) return null;
    if (t.source.kind === "vehicle" && !Array.isArray(t.source.tiltZones)) t.source.tiltZones = []; // 区間を入れる前に保存したもの
    if (t.source.kind === "file") t.source.lines = (t.source.lines as unknown as EN[][]).map((l) => l.map((en) => toLonLatZone(8, en)));
    return t;
  } catch {
    return null;
  }
}
