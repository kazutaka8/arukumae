/**
 * 軌跡図の読み書き（F2）。
 *
 * 読む：KML（Google マイマップなどの書き出し）か GeoJSON の線・多角形を集め、その縁の点を中心線に投影して、
 *   1m ごとの「左右どこまで掃いたか」（vehicle.ts の Sweep）にする。
 *   外側線・内側線・多角形のどれで描かれていても同じ扱いになり、区切りの作り方を1つにできる。
 *   本物の軌跡図は発注者のまだ公表していない計画であることがある。読んだ座標はこの端末の外へ出さない（spec §8.7）。
 * 書く：架空の軌跡図を KML と GeoJSON にする。運送会社の軌跡図が届く前の打ち合わせや、ほかの地図ソフトで重ねるため。
 */
import { strFromU8, unzipSync } from "fflate";
import type { Feature, FeatureCollection, LineString, Polygon, Position } from "geojson";
import { resample, StationIndex } from "./geom";
import { toLonLat, toPlane, type EN } from "./proj";
import type { Sweep } from "./vehicle";

export type LonLat = [number, number];

/* ---------- 読む ---------- */

/** KML か GeoJSON の文字列から、線と多角形の縁（緯度経度の点列）を全部取り出す。点（Point）は使わない */
export function parseTrackFile(name: string, text: string): LonLat[][] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("PK")) throw new Error(`${name} は zip（KMZ）のようです。parseTrackBytes で読んでください`);
  if (trimmed.startsWith("{")) return linesFromGeoJSON(JSON.parse(text));
  if (trimmed.startsWith("<")) return linesFromKml(text);
  throw new Error(`${name} は KML でも GeoJSON でもないようです`);
}

/**
 * ファイルのバイト列から読む。KMZ（zip の中に doc.kml などの KML が 1 つ入ったもの。Google Earth の既定の保存形）なら解凍して中の KML を読む。
 * 中の画像などは使わない
 */
export function parseTrackBytes(name: string, bytes: Uint8Array): LonLat[][] {
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (!isZip) return parseTrackFile(name, new TextDecoder("utf-8").decode(bytes));
  const entries = unzipSync(bytes, { filter: (f) => f.name.toLowerCase().endsWith(".kml") });
  const names = Object.keys(entries).sort((a, b) => (a.toLowerCase() === "doc.kml" ? -1 : b.toLowerCase() === "doc.kml" ? 1 : a.localeCompare(b)));
  if (!names.length) throw new Error(`${name} の中に KML がありません`);
  return parseTrackFile(names[0], strFromU8(entries[names[0]]));
}

function linesFromKml(xml: string): LonLat[][] {
  // DOMParser はテストの環境（Node）にないので、正規表現で拾う。
  // Placemark ごとに見て、この道具が書き出した「伐採範囲の外側」は飛ばす（掃く範囲に余裕幅と伐採の幅を二重に足さないため）。
  // 中身は LineString と LinearRing（多角形の縁）の <coordinates>。"経度,緯度[,高さ]" を空白で区切ったもの
  const out: LonLat[][] = [];
  const blocks = xml.match(/<Placemark\b[\s\S]*?<\/Placemark>/g) ?? [xml];
  for (const block of blocks) {
    const name = /<name>([\s\S]*?)<\/name>/.exec(block)?.[1] ?? "";
    if (name.includes("伐採範囲")) continue;
    const re = /<(?:LineString|LinearRing)\b[^>]*>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) {
      const pts: LonLat[] = [];
      for (const tok of m[1].trim().split(/\s+/)) {
        const [lon, lat] = tok.split(",").map(Number);
        if (Number.isFinite(lon) && Number.isFinite(lat)) pts.push([lon, lat]);
      }
      if (pts.length >= 2) out.push(pts);
    }
  }
  return out;
}

function linesFromGeoJSON(json: unknown): LonLat[][] {
  const out: LonLat[][] = [];
  const push = (coords: Position[]) => {
    const pts = coords.filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1])).map((c) => [c[0], c[1]] as LonLat);
    if (pts.length >= 2) out.push(pts);
  };
  const walkGeom = (g: { type: string; coordinates?: unknown; geometries?: unknown[] } | null | undefined) => {
    if (!g) return;
    switch (g.type) {
      case "LineString":
        push(g.coordinates as Position[]);
        break;
      case "MultiLineString":
      case "Polygon":
        (g.coordinates as Position[][]).forEach(push);
        break;
      case "MultiPolygon":
        (g.coordinates as Position[][][]).forEach((poly) => poly.forEach(push));
        break;
      case "GeometryCollection":
        (g.geometries as typeof g[]).forEach(walkGeom);
        break;
    }
  };
  const j = json as { type?: string; features?: { geometry?: unknown; properties?: { kind?: string } | null }[]; geometry?: unknown };
  // この道具が書き出した「伐採範囲の外側」（kind: cut）は飛ばす。KML と同じ理由
  if (j.type === "FeatureCollection") j.features?.filter((f) => f.properties?.kind !== "cut").forEach((f) => walkGeom(f.geometry as Parameters<typeof walkGeom>[0]));
  else if (j.type === "Feature") walkGeom(j.geometry as Parameters<typeof walkGeom>[0]);
  else walkGeom(j as Parameters<typeof walkGeom>[0]);
  return out;
}

/**
 * 線・多角形の縁を中心線に投影して Sweep にする。
 * - 縁は 1m ごとに打ち直してから投影する（頂点だけだと間が抜ける）
 * - 中心線から maxDist より遠い点は無視する（別の道の軌跡）
 * - 点のない所は、maxGap（m）までなら両隣から直線で埋める。それより長く途切れた所は NaN（軌跡図がない）
 * - 片側だけ点がある所は、もう片側を 0 にする（掃く範囲が中心線まで届いていない）
 */
export function sweepFromLines(dense: EN[], normals: EN[], lines: EN[][], maxDist = 120, maxGap = 10): Sweep {
  const n = dense.length;
  const left = new Float64Array(n).fill(NaN);
  const right = new Float64Array(n).fill(NaN);
  const index = new StationIndex(dense);
  for (const line of lines) {
    for (const p of resample(line, 1)) {
      const near = index.nearest(p, maxDist);
      if (!near) continue;
      const s = near.index;
      const d = (p[0] - dense[s][0]) * normals[s][0] + (p[1] - dense[s][1]) * normals[s][1];
      if (d >= 0) {
        if (!(left[s] >= d)) left[s] = d;
      } else if (!(right[s] >= -d)) right[s] = -d;
    }
  }
  fillGaps(left, maxGap);
  fillGaps(right, maxGap);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(left[i]) && !Number.isFinite(right[i])) right[i] = 0;
    else if (Number.isFinite(right[i]) && !Number.isFinite(left[i])) left[i] = 0;
  }
  return { left, right };
}

function fillGaps(a: Float64Array, maxGap: number) {
  let i = 0;
  while (i < a.length) {
    if (Number.isFinite(a[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < a.length && !Number.isFinite(a[j])) j++;
    // i..j-1 が抜け。両側に値があり、短ければ直線で埋める
    if (i > 0 && j < a.length && j - i <= maxGap) {
      for (let k = i; k < j; k++) a[k] = a[i - 1] + ((a[j] - a[i - 1]) * (k - i + 1)) / (j - i + 1);
    }
    i = j;
  }
}

/** 緯度経度の点列を平面直角座標に */
export function linesToPlane(lines: LonLat[][]): EN[][] {
  return lines.map((l) => l.map((c) => toPlane(c)));
}

/* ---------- 書く ---------- */

export interface TrackProps {
  name: string;
  /** sweep＝掃く範囲、cut＝伐採範囲の外側、tilt＝起立の区間（地図の表示だけ。ファイルには書かない） */
  kind: "sweep" | "cut" | "tilt";
  side?: "L" | "R";
  label?: string;
}

/**
 * Sweep と伐採範囲の外側を、地図に出す・ファイルに書く GeoJSON にする。
 * 掃く範囲は多角形（左の縁＋右の縁を逆順）、縁と伐採範囲の外側は線。情報のない所（NaN）で切れる
 */
export function trackGeoJSON(
  dense: EN[],
  normals: EN[],
  sweep: Sweep,
  outer: { left: ArrayLike<number>; right: ArrayLike<number> } | null,
): FeatureCollection<Polygon | LineString, TrackProps> {
  const features: Feature<Polygon | LineString, TrackProps>[] = [];
  const at = (i: number, off: number, sgn: 1 | -1): Position => toLonLat([dense[i][0] + sgn * normals[i][0] * off, dense[i][1] + sgn * normals[i][1] * off]);
  for (const [a, b] of runs(sweep.left)) {
    const leftPts: Position[] = [];
    const rightPts: Position[] = [];
    for (let i = a; i <= b; i++) {
      leftPts.push(at(i, sweep.left[i], 1));
      rightPts.push(at(i, sweep.right[i], -1));
    }
    const ring = [...leftPts, ...[...rightPts].reverse(), leftPts[0]];
    features.push({ type: "Feature", properties: { name: "掃く範囲", kind: "sweep" }, geometry: { type: "Polygon", coordinates: [ring] } });
    features.push({ type: "Feature", properties: { name: "掃く範囲の左の縁", kind: "sweep", side: "L" }, geometry: { type: "LineString", coordinates: leftPts } });
    features.push({ type: "Feature", properties: { name: "掃く範囲の右の縁", kind: "sweep", side: "R" }, geometry: { type: "LineString", coordinates: rightPts } });
    if (outer) {
      const ol: Position[] = [];
      const or: Position[] = [];
      for (let i = a; i <= b; i++) {
        ol.push(at(i, outer.left[i], 1));
        or.push(at(i, outer.right[i], -1));
      }
      features.push({ type: "Feature", properties: { name: "伐採範囲の外側（左）", kind: "cut", side: "L" }, geometry: { type: "LineString", coordinates: ol } });
      features.push({ type: "Feature", properties: { name: "伐採範囲の外側（右）", kind: "cut", side: "R" }, geometry: { type: "LineString", coordinates: or } });
    }
  }
  return { type: "FeatureCollection", features };
}

/** 値のある添字の連続した区間 [a, b]（両端を含む） */
function runs(a: Float64Array): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= a.length; i++) {
    const ok = i < a.length && Number.isFinite(a[i]);
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) {
      if (i - 1 > start) out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

/** KML にする。Google Earth・マイマップ・QGIS で開ける。架空であることを説明に書く */
export function trackKml(fc: FeatureCollection<Polygon | LineString, TrackProps>, title: string, description: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const coords = (pts: Position[]) => pts.map((c) => `${c[0].toFixed(7)},${c[1].toFixed(7)},0`).join(" ");
  const placemarks = fc.features
    .filter((f) => f.properties.kind !== "tilt")
    .map((f) => {
      const style = f.properties.kind === "sweep" ? "#sweep" : "#cut";
      const geom =
        f.geometry.type === "Polygon"
          ? `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords(f.geometry.coordinates[0])}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
          : `<LineString><tessellate>1</tessellate><coordinates>${coords(f.geometry.coordinates)}</coordinates></LineString>`;
      return `    <Placemark><name>${esc(f.properties.name)}</name><styleUrl>${style}</styleUrl>${geom}</Placemark>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(title)}</name>
    <description>${esc(description)}</description>
    <Style id="sweep"><LineStyle><color>ffa21f7b</color><width>2</width></LineStyle><PolyStyle><color>33a21f7b</color></PolyStyle></Style>
    <Style id="cut"><LineStyle><color>ff0098ff</color><width>2</width></LineStyle></Style>
${placemarks}
  </Document>
</kml>
`;
}
