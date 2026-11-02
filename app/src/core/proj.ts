/**
 * 平面直角座標系 第VIII系（JGD2011、EPSG:6676）と緯度経度の換算。
 *
 * 公図（地図XML）の座標はこの系で、X が北・Y が東（測量の慣習）。
 * 画面の上での計算（距離・面積・区切り）はこの平面の上で行い、地図に出すときだけ緯度経度に戻す。
 * 値が前処理（tools/jgd8.py）と合うことを proj.test.ts で固定している。
 */
import proj4 from "proj4";

proj4.defs(
  "EPSG:6676",
  "+proj=tmerc +lat_0=36 +lon_0=138.5 +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs",
);

/** 平面直角座標。e＝東（公図の Y）、n＝北（公図の X）。計算では数学の向き（横が e）で扱う */
export type EN = [e: number, n: number];
export type LonLat = [lon: number, lat: number];

export function toPlane([lon, lat]: LonLat): EN {
  const [e, n] = proj4("EPSG:4326", "EPSG:6676", [lon, lat]);
  return [e, n];
}

export function toLonLat([e, n]: EN): LonLat {
  const [lon, lat] = proj4("EPSG:6676", "EPSG:4326", [e, n]);
  return [lon, lat];
}
