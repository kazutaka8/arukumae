/**
 * 「伐採範囲をどう決めているか」の状態（手順 2）。3 つの出どころを同じ形（Sweep → 外側の距離）に落とす。
 * - vehicle：車両の寸法から計算した架空の軌跡図（vehicle.ts）
 * - file：読み込んだ軌跡図（KML・GeoJSON。track.ts）
 * - band：仮の帯（中心線から一定の幅）。軌跡図も車両もないときの代わり
 * この端末に残す（localStorage）。読んだ軌跡図の座標もこの端末の中だけ
 */
import { buildSegments, type Segment } from "./geom";
import type { EN } from "./proj";
import { sweepFromLines } from "./track";
import { curveFlags, DEFAULT_BAND, flatSweep, outerFromSweep, PRESETS, sweepVehicle, type BandParams, type PresetId, type Sweep, type Vehicle } from "./vehicle";

export type TrackSource =
  | { kind: "vehicle"; preset: PresetId; vehicle: Vehicle }
  | { kind: "file"; name: string; lines: EN[][] }
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
  source: { kind: "vehicle", preset: "lifter", vehicle: { ...PRESETS.lifter.vehicle } },
  band: { ...DEFAULT_BAND },
};

export function computeTrack(dense: EN[], normals: EN[], t: TrackSetting): TrackResult {
  const curve = curveFlags(dense);
  let sweep: Sweep;
  switch (t.source.kind) {
    case "vehicle":
      sweep = sweepVehicle(dense, normals, t.source.vehicle, curve);
      break;
    case "file":
      sweep = sweepFromLines(dense, normals, t.source.lines);
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
      return `架空の軌跡図（${PRESETS[s.preset].name}、ブレード ${s.vehicle.bladeLength}m${s.vehicle.tilt ? `・${s.vehicle.tilt}°${s.vehicle.tiltCurve !== undefined && s.vehicle.tiltCurve !== s.vehicle.tilt ? `／曲がりで ${s.vehicle.tiltCurve}°` : ""} に立てる` : "・水平"}）${tail}`;
    case "file":
      return `軌跡図「${s.name}」${tail}`;
    case "band":
      return `仮の帯：中心線から ${t.band.roadHalf}〜${s.halfWidth}m`;
  }
}

/** 保存の形。Float64Array は JSON にできないので、線の座標（数の配列）だけを持つ */
export function saveTrack(key: string, t: TrackSetting) {
  localStorage.setItem(key, JSON.stringify(t));
}

export function loadTrack(key: string): TrackSetting | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const t = JSON.parse(raw) as TrackSetting;
    if (!t.source || !t.band) return null;
    if (t.source.kind === "vehicle" && !(t.source.preset in PRESETS)) return null;
    return t;
  } catch {
    return null;
  }
}
