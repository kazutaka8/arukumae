/**
 * 公図の自動取得（spec §17.3）。
 * 1. 中心線と、伐採範囲の外側（両側 200m）の点で、100m ごとに通る市町村を当てる（OpenStreetMap の行政境界。Overpass の is_in）
 * 2. G空間情報センターの CKAN（package_search）で、その市町村の「登記所備付地図データ」のいちばん新しい年版を探す。
 *    zip の名前が市区町村コードで始まることを確かめる（同名の町村の取り違えを防ぐ。OSM の関係の ref がコード＋検査数字）
 * 3. 同意のあとで取得する（取得と読み込みは mojxml.worker.ts。URL をワーカーに渡して流し読みする）
 *
 * ここは問い合わせと答えの読み方だけ。画面と同意は main.ts。
 * 国土地理院の逆ジオコーダは利用条件を確かめられていないので使わない（spec §17.3）
 */
import { leftNormals, resample } from "./geom";
import { toLonLat, toPlane, type LonLat } from "./proj";

/**
 * Overpass の入口。本家は混んでいて 502・504 を返すことがあるので、だめなら公開の写しに回す。順に試し、全部だめなら最後の理由を投げる。
 * 写しが答えないまま何分も待つことがあった（2026-11-03 に実測。6 分以上）ので、1 つにつき timeoutMs で打ち切る
 */
export const OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

export async function overpass(query: string, fetchFn: typeof fetch = fetch, timeoutMs = 75_000): Promise<unknown> {
  let last: Error | null = null;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetchFn(url, { method: "POST", body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw new Error(`OpenStreetMap の問い合わせ先（Overpass）が答えませんでした（${last?.name === "TimeoutError" ? "時間切れ" : (last?.message ?? "")}）。混んでいることがあります。少し待ってもう一度か、手で描いてください`);
}
export const CKAN_SEARCH_URL = "https://www.geospatial.jp/ckan/api/3/action/package_search";
export const CKAN_DATASET_BASE = "https://www.geospatial.jp/ckan/dataset/";

/**
 * 市町村を当てる点：中心線の 100m ごとと、その両側 sideM の点。
 * 境に沿う道で隣の市町村が抜けないように、伐採範囲の外側でも当てる（Codex の指摘 2026-11-03）
 */
export function samplePoints(line: LonLat[], stepM = 100, sideM = 200): LonLat[] {
  const dense = resample(line.map((c) => toPlane(c)), 1);
  const normals = leftNormals(dense);
  const out: LonLat[] = [];
  const idx: number[] = [];
  for (let i = 0; i < dense.length; i += stepM) idx.push(i);
  if (idx[idx.length - 1] !== dense.length - 1) idx.push(dense.length - 1);
  for (const i of idx) {
    const [e, n] = dense[i];
    const [nx, ny] = normals[i];
    out.push(toLonLat([e, n]), toLonLat([e + nx * sideM, n + ny * sideM]), toLonLat([e - nx * sideM, n - ny * sideM]));
  }
  return out;
}

export interface Municipality {
  name: string;
  /** 市区町村コード（5 桁）。OSM の ref（6 桁＝コード＋検査数字）から。無ければ null */
  code: string | null;
  /** admin_level（7＝市町村・特別区、8＝政令市の区） */
  level: number;
  osmId: number;
}

export function overpassQuery(points: LonLat[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const [lon, lat] of points) {
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`is_in(${lat.toFixed(6)},${lon.toFixed(6)});rel(pivot)["boundary"="administrative"]["admin_level"~"^(7|8)$"];`);
  }
  return `[out:json][timeout:90];(${parts.join("")});out tags;`;
}

/** Overpass の答えから市町村を取り出す。政令市（admin_level 7）の中の区（8）があれば、区のほうを使う（法務省のデータは区ごと） */
export function parseMunicipalities(json: unknown): Municipality[] {
  const els = (json as { elements?: { type: string; id: number; tags?: Record<string, string> }[] }).elements ?? [];
  const out: Municipality[] = [];
  const seen = new Set<number>();
  for (const e of els) {
    if (e.type !== "relation" || !e.tags || seen.has(e.id)) continue;
    const level = Number(e.tags.admin_level);
    if (level !== 7 && level !== 8) continue;
    const name = e.tags["name:ja"] ?? e.tags.name ?? "";
    if (!name) continue;
    const ref = e.tags.ref ?? "";
    const code = /^\d{6}$/.test(ref) ? ref.slice(0, 5) : /^\d{5}$/.test(ref) ? ref : null;
    seen.add(e.id);
    out.push({ name, code, level, osmId: e.id });
  }
  const wards = out.filter((m) => m.level === 8);
  // コード順（県 → 市町村の順になる）。コードのないものは後ろ
  return out.filter((m) => m.level === 8 || !wards.some((w) => w.name.startsWith(m.name))).sort((a, b) => (a.code ?? "99999").localeCompare(b.code ?? "99999") || a.name.localeCompare(b.name));
}

export async function findMunicipalities(points: LonLat[], fetchFn: typeof fetch = fetch): Promise<Municipality[]> {
  return parseMunicipalities(await overpass(overpassQuery(points), fetchFn));
}

/** CKAN のデータセットのうち、使う 1 つ（いちばん新しい年版の zip） */
export interface MojDataset {
  city: string;
  code: string;
  title: string;
  datasetName: string;
  datasetUrl: string;
  zipName: string;
  zipUrl: string;
  /** バイト。CKAN の値（取得先は Content-Length を見せないので、進み具合はこの値で出す） */
  size: number | null;
  year: string;
  licenseUrl: string | null;
}

interface CkanPackage {
  name: string;
  title: string;
  tags?: { name: string }[];
  resources?: { name: string; url: string; size?: number | null; format?: string }[];
}

/**
 * 検索の結果から、その市町村のいちばん新しい zip を選ぶ。
 * - コードが分かっていれば、zip の名前がコードで始まるものだけ（同名の町村を取り違えない）
 * - 分からなければ、タグに市町村名があるものだけ（候補が 2 つ以上の市町村にまたがれば null。人が選ぶ）
 */
export function pickDataset(packages: CkanPackage[], name: string, code: string | null): MojDataset | null {
  let best: MojDataset | null = null;
  const codes = new Set<string>();
  for (const p of packages) {
    const tagged = (p.tags ?? []).some((t) => t.name === name || t.name.endsWith(name));
    const license = (p.resources ?? []).find((r) => /利用規約/.test(r.name) || (r.format ?? "").toUpperCase() === "PDF")?.url ?? null;
    for (const r of p.resources ?? []) {
      const m = /^(\d{5})-\d{4}-(\d{4})\.zip$/i.exec(r.name);
      if (!m) continue;
      if (code ? m[1] !== code : !tagged) continue;
      codes.add(m[1]);
      const cand: MojDataset = {
        city: name,
        code: m[1],
        title: p.title,
        datasetName: p.name,
        datasetUrl: CKAN_DATASET_BASE + p.name,
        zipName: r.name,
        zipUrl: r.url,
        size: typeof r.size === "number" ? r.size : null,
        year: m[2],
        licenseUrl: license,
      };
      if (!best || cand.year > best.year) best = cand;
    }
  }
  if (!code && codes.size > 1) return null;
  return best;
}

export async function searchDataset(name: string, code: string | null, fetchFn: typeof fetch = fetch): Promise<MojDataset | null> {
  const q = `登記所備付地図データ ${name}`;
  // 年版ごとに別のデータセットで、名前の語が多くの題名に入る市町村（「長野市」なら河内長野市も）では件数が増える。100 件まで取る
  const res = await fetchFn(`${CKAN_SEARCH_URL}?q=${encodeURIComponent(q)}&rows=100`);
  if (!res.ok) throw new Error(`G空間情報センターが答えませんでした（HTTP ${res.status}）`);
  const json = (await res.json()) as { success?: boolean; result?: { results?: CkanPackage[] } };
  if (!json.success || !json.result) throw new Error("G空間情報センターの答えの形が違います");
  return pickDataset(json.result.results ?? [], name, code);
}

export function fmtMb(bytes: number | null): string {
  return bytes === null ? "大きさ不明" : `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}
