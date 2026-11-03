/**
 * 平面直角座標系（JGD2011。第I〜XIX系、EPSG:6669〜6687）と緯度経度の換算。
 *
 * 公図（地図XML）の座標はこの系で、X が北・Y が東（測量の慣習）。
 * 画面の上での計算（距離・面積・区切り）はこの平面の上で行い、地図に出すときだけ緯度経度に戻す。
 *
 * 2026-11-03 までは第VIII系（長野）に固定していた。別の県（岩手なら第X系）では公図が別の座標になる（Codex の仕様レビュー）。
 * そこで「いまの系」を 1 つ持ち（案件の中心線の場所から決める。zoneOf）、toPlane・toLonLat はその系で換算する。
 * 公図の地図は自分の系を <座標系>（公共座標8系 など）で名乗るので、そちらは zoneFromCrs で読み、toLonLatZone で系を指定して換算する。
 * 値が前処理（tools/jgd8.py）と合うことを proj.test.ts で固定している。
 */
import proj4 from "proj4";

/** 平面直角座標。e＝東（公図の Y）、n＝北（公図の X）。計算では数学の向き（横が e）で扱う */
export type EN = [e: number, n: number];
export type LonLat = [lon: number, lat: number];

/** 各系の原点（緯度・経度）。国土地理院「平面直角座標系（平成十四年国土交通省告示第九号）」の表のとおり */
export const ZONES: { lat0: number; lon0: number }[] = [
  { lat0: 33, lon0: 129.5 }, // I
  { lat0: 33, lon0: 131 }, // II
  { lat0: 36, lon0: 132 + 10 / 60 }, // III
  { lat0: 33, lon0: 133.5 }, // IV
  { lat0: 36, lon0: 134 + 20 / 60 }, // V
  { lat0: 36, lon0: 136 }, // VI
  { lat0: 36, lon0: 137 + 10 / 60 }, // VII
  { lat0: 36, lon0: 138.5 }, // VIII
  { lat0: 36, lon0: 139 + 50 / 60 }, // IX
  { lat0: 40, lon0: 140 + 50 / 60 }, // X
  { lat0: 44, lon0: 140.25 }, // XI
  { lat0: 44, lon0: 142.25 }, // XII
  { lat0: 44, lon0: 144.25 }, // XIII
  { lat0: 26, lon0: 142 }, // XIV
  { lat0: 26, lon0: 127.5 }, // XV
  { lat0: 26, lon0: 124 }, // XVI
  { lat0: 26, lon0: 131 }, // XVII
  { lat0: 20, lon0: 136 }, // XVIII
  { lat0: 26, lon0: 154 }, // XIX
];

export const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX"];

/** 第 n 系の EPSG コード（JGD2011）。第I系が 6669 */
export function epsgOf(zone: number): string {
  return `EPSG:${6668 + zone}`;
}

function ensureDef(zone: number) {
  const code = epsgOf(zone);
  if (!proj4.defs(code)) {
    const z = ZONES[zone - 1];
    if (!z) throw new Error(`平面直角座標系の系は 1〜19 です：${zone}`);
    proj4.defs(code, `+proj=tmerc +lat_0=${z.lat0} +lon_0=${z.lon0} +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs`);
  }
  return code;
}

/** いまの系（案件の場所で決める）。既定は第VIII系（見本の小川村） */
let current = 8;

export function currentZone(): number {
  return current;
}

export function setZone(zone: number) {
  if (!Number.isInteger(zone) || zone < 1 || zone > 19) throw new Error(`平面直角座標系の系は 1〜19 です：${zone}`);
  current = zone;
}

export function toPlane(ll: LonLat): EN {
  return toPlaneZone(current, ll);
}

export function toLonLat(en: EN): LonLat {
  return toLonLatZone(current, en);
}

export function toPlaneZone(zone: number, [lon, lat]: LonLat): EN {
  const [e, n] = proj4("EPSG:4326", ensureDef(zone), [lon, lat]);
  return [e, n];
}

export function toLonLatZone(zone: number, [e, n]: EN): LonLat {
  const [lon, lat] = proj4(ensureDef(zone), "EPSG:4326", [e, n]);
  return [lon, lat];
}

/**
 * 場所から、計算に使う系を決める。
 * 本来の系は都道府県で決まっている（県境をまたぐ道は 2 つの系にかかる）が、ここで選ぶのは「計算の平面」で、
 * 公図の系は地図XML の <座標系> から別に読む（違えば換算して合わせる。mojxml.ts）。
 * だから厳密な県の割り当ては要らず、原点がいちばん近い系でよい（原点から 1 度離れても縮尺の差は 1 万分の 1.5 ほど）。
 * - 北緯 30 度より南は島の系（XIV〜XIX）を経度で分ける
 * - 北緯 41.6 度より北は北海道の系（XI〜XIII）
 * - それ以外は I〜X のうち経度の原点がいちばん近いもの
 */
export function zoneOf([lon, lat]: LonLat): number {
  if (lat < 30) {
    if (lon < 125) return 16;
    if (lon < 129.5) return 15;
    if (lon < 133) return 17;
    if (lon < 139) return 18;
    if (lon < 150) return 14;
    return 19;
  }
  const from = lat >= 41.6 ? 11 : 1;
  const to = lat >= 41.6 ? 13 : 10;
  let best = from;
  for (let z = from; z <= to; z++) if (Math.abs(ZONES[z - 1].lon0 - lon) < Math.abs(ZONES[best - 1].lon0 - lon)) best = z;
  return best;
}

/**
 * 地図XML の <座標系> から系の番号を読む。「公共座標8系」「公共座標系第8系」「公共座標VIII系」のような書き方を受ける。
 * 任意座標系なら null
 */
export function zoneFromCrs(crs: string): number | null {
  if (!crs || !crs.startsWith("公共")) return null;
  const digits = /(\d{1,2})\s*系/.exec(crs.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
  if (digits) {
    const z = Number(digits[1]);
    return z >= 1 && z <= 19 ? z : null;
  }
  const roman = /([IVX]+)\s*系/.exec(crs.replace(/[ＩＶＸ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
  if (roman) {
    const i = ROMAN.indexOf(roman[1]);
    return i >= 0 ? i + 1 : null;
  }
  return null;
}

/** 画面に出す系の名前。「第VIII系（長野など）」 */
export function zoneLabel(zone: number): string {
  return `第${ROMAN[zone - 1] ?? "?"}系`;
}
