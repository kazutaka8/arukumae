/**
 * 中心線（spec §17.2）。出どころは 3 つ（軌跡図の KML の線・OpenStreetMap の道路・手で描く）で、どれも緯度経度の折れ線にする。
 * ここは、KML の線から中心線を選ぶ所と、向き・長さの小さな計算。OSM をたどるのは osmroute.ts。
 */
import type { NamedLine } from "./track";
import type { LonLat } from "./proj";

/** 名前に中心線らしい言葉があれば、その線を最初から選んでおく（運送会社の軌跡図は「中心線」「CL」などの名前で線を分けていることが多い） */
const CENTER_WORDS = /中心線|センター|軌跡中心|\bCL\b|center ?line|centre ?line|\bcenter\b/i;

export interface LineChoice extends NamedLine {
  lengthM: number;
}

/** 線に長さを付け、長い順に並べる（中心線はたいてい一番長い線のどれか） */
export function lineChoices(lines: NamedLine[]): LineChoice[] {
  return lines.map((l) => ({ ...l, lengthM: lengthM(l.coords) })).sort((a, b) => b.lengthM - a.lengthM);
}

/**
 * 最初から選んでおく線の添字。名前が中心線らしいものがあればそれ（複数なら一番長い）。なければ -1（人が選ぶ）。
 * 多角形の縁は中心線にならないので候補にしない
 */
export function pickCenterline(choices: LineChoice[]): number {
  let best = -1;
  choices.forEach((c, i) => {
    if (c.ring || !CENTER_WORDS.test(c.name)) return;
    if (best < 0 || c.lengthM > choices[best].lengthM) best = i;
  });
  return best;
}

/** 折れ線の長さ（m）。緯度経度のまま、短い距離なので平面近似で足す */
export function lengthM(coords: LonLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += distM(coords[i - 1], coords[i]);
  return total;
}

/** 2 点の距離（m）。正距円筒の近似。数 km までなら誤差は 1m 未満 */
export function distM(a: LonLat, b: LonLat): number {
  const R = 6371008.8;
  const lat = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (b[0] - a[0]) * (Math.PI / 180) * Math.cos(lat) * R;
  const dy = (b[1] - a[1]) * (Math.PI / 180) * R;
  return Math.hypot(dx, dy);
}

/** 向きを反転する（起点と終点を入れ替える） */
export function reversed(coords: LonLat[]): LonLat[] {
  return [...coords].reverse();
}

/** 同じ点が続く所を 1 つにする（KML の線は頂点が重なっていることがあり、区切りの計算で長さ 0 の辺が困る） */
export function dedupe(coords: LonLat[]): LonLat[] {
  const out: LonLat[] = [];
  for (const c of coords) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - c[0]) < 1e-9 && Math.abs(last[1] - c[1]) < 1e-9) continue;
    out.push(c);
  }
  return out;
}

/** 中心線として使えるか。2 点以上、長さ 20m 以上、長さ 50km 以下（それより長いと区切りが数万になり、この道具の想定の外） */
export function validateCenterline(coords: LonLat[]): string | null {
  const c = dedupe(coords);
  if (c.length < 2) return "点が 2 つ以上要ります";
  const L = lengthM(c);
  if (L < 20) return `短すぎます（約 ${Math.round(L)}m）。20m 以上の線にしてください`;
  if (L > 50_000) return `長すぎます（約 ${(L / 1000).toFixed(1)}km）。この道具は 1 区間 50km までを想定しています。区間を分けてください`;
  return null;
}

/** 道路名の候補を線の名前から拾う。「中心線」などの言葉を除いた残り。何もなければ空 */
export function roadNameFromLine(name: string): string {
  return name.replace(CENTER_WORDS, "").replace(/[（(].*?[)）]/g, "").replace(/[_\-－ー・:：\s]+$/g, "").trim();
}

/** 折れ線の真ん中あたりの点（系を決めるときと、地図を寄せるときに） */
export function midpoint(coords: LonLat[]): LonLat {
  return coords[Math.floor(coords.length / 2)];
}

export function bboxOf(coords: LonLat[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}
