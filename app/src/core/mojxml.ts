/**
 * 公図（地図XML）をブラウザの中で読む（F2）。法務省「登記所備付地図データ」の XML から筆の形を取り出し、
 * 区間の周りの筆だけを残す。前処理の tools/cut_parcels.py と同じ結果になるように作る（同じ id の付け方・同じ絞り方）。
 *
 * - 主の地図は展開すると約 170MB。DOMParser に渡すと木が GB 級になるので、文字列を少しずつ受け取りながら
 *   必要な要素（GM_Point・GM_Curve・GM_Surface・筆・座標系など）だけを切り出して読む。切り出した要素は小さいので正規表現で読む
 * - 点は GM_Point で定義して GM_Curve が id で参照する形と、GM_Curve の中に座標を直接書く形があり、同じファイルに混ざる
 * - 座標は X が北・Y が東（spec §8.2）。この道具の平面座標 EN は [東, 北] なので入れ替える
 * - 任意座標系の地図は緯度経度にできないので、読み飛ばして枚数だけ伝える（F4 の対象）
 * - ファイルの中身はこの端末の外へ出さない（計算は全部ここで終わる）
 */
import { StationIndex } from "./geom";
import type { ParcelFeature } from "./parcels";
import { toLonLat, type EN } from "./proj";
import type { ParcelKind } from "./types";

export interface MojParcel {
  /** XML の中の id（例 H000000001） */
  id: string;
  oaza: string | null;
  chiban: string;
  kind: ParcelKind;
  accuracy: string | null;
  survey: string | null;
  /** 外周と穴。平面直角座標（EN） */
  rings: EN[][];
}

export interface MojMap {
  /** ファイル名（拡張子・フォルダなし。例 20588-1000-6）。筆の id の頭に使う */
  stem: string;
  name: string;
  city: string;
  crs: string;
  /** 公共座標系（平面直角座標系）なら true。任意座標系は false */
  isPublic: boolean;
  parcels: MojParcel[];
  /** 形のない筆（形状の参照先がない）の数。読み落としの手がかり */
  noShape: number;
  /** 地図XML として読めたか（根の要素 <地図> があった）。KML など別の XML を落とされたときに false */
  recognized: boolean;
}

const KIND_RE = /^(道|水|無地番|地区外|別図|筆界未定地)-/;

/** 地番の頭で種類を分ける。「道-123」「無地番-45」のような書き方に合わせる */
export function kindOf(chiban: string): ParcelKind {
  const m = KIND_RE.exec(chiban ?? "");
  return (m ? m[1] : "ふつう") as ParcelKind;
}

export function stemOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(/\.[^.]+$/, "");
}

function unescapeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, k) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[k as string] ?? "");
}

interface RawFude {
  id: string;
  oaza: string | null;
  chiban: string;
  shape: string | null;
  accuracy: string | null;
  survey: string | null;
}

/**
 * 流し読みの読み手。push() で文字列を足していき、end() で地図を返す。
 * 要素の途中で文字列が切れていれば、そこから先は次の push まで持ち越す。
 */
export class MojxmlParser {
  readonly stem: string;
  private buf = "";
  private prefix: string | null = null;
  private pts = new Map<string, EN>();
  private curves = new Map<string, (string | EN)[]>();
  private surfs = new Map<string, { ext: string[]; holes: string[][] }>();
  private fude: RawFude[] = [];
  private meta: Record<string, string> = {};
  private tokens: { open: string; close: string; kind: "point" | "curve" | "surface" | "fude" | "meta" }[] = [];
  private maxToken = 0;
  private recognized = false;

  constructor(fileName: string) {
    this.stem = stemOf(fileName);
  }

  push(text: string) {
    this.buf += text;
    this.drain(false);
  }

  end(): MojMap {
    this.drain(true);
    this.buf = "";
    const parcels: MojParcel[] = [];
    let noShape = 0;
    for (const f of this.fude) {
      const s = f.shape ? this.surfs.get(f.shape) : undefined;
      if (!s) {
        noShape++;
        continue;
      }
      const rings = [this.ring(s.ext), ...s.holes.map((h) => this.ring(h))].filter((r) => r.length >= 4);
      if (!rings.length) {
        noShape++;
        continue;
      }
      parcels.push({ id: f.id, oaza: f.oaza, chiban: f.chiban, kind: kindOf(f.chiban), accuracy: f.accuracy, survey: f.survey, rings });
    }
    const crs = this.meta["座標系"] ?? "";
    return { stem: this.stem, name: this.meta["地図名"] ?? "", city: this.meta["市区町村名"] ?? "", crs, isPublic: crs.startsWith("公共"), parcels, noShape, recognized: this.recognized };
  }

  /** 図面の名前空間の接頭辞（ふつう zmn:）を根の要素から決める */
  private settle(final: boolean): boolean {
    if (this.prefix !== null) return true;
    const rootAt = this.buf.indexOf("<地図");
    const rootEnd = rootAt < 0 ? -1 : this.buf.indexOf(">", rootAt);
    if (rootEnd < 0) {
      // 根の要素がまだ来ていない。先頭が 64KB を超えても来なければ、地図XML ではない
      if (!final && this.buf.length < 65536) return false;
      this.prefix = "zmn:";
    } else {
      this.recognized = true;
      const head = this.buf.slice(0, rootEnd + 1);
      const m = /xmlns:([A-Za-z_][\w.-]*)="http:\/\/www\.moj\.go\.jp\/MINJI\/tizuzumen"/.exec(head);
      this.prefix = m ? `${m[1]}:` : /xmlns="http:\/\/www\.moj\.go\.jp\/MINJI\/tizuzumen"/.test(head) ? "" : "zmn:";
    }
    const p = this.prefix;
    this.tokens = [
      { open: `<${p}GM_Point `, close: `</${p}GM_Point>`, kind: "point" },
      { open: `<${p}GM_Curve `, close: `</${p}GM_Curve>`, kind: "curve" },
      { open: `<${p}GM_Surface `, close: `</${p}GM_Surface>`, kind: "surface" },
      { open: "<筆 ", close: "</筆>", kind: "fude" },
      { open: "<座標系>", close: "</座標系>", kind: "meta" },
      { open: "<地図名>", close: "</地図名>", kind: "meta" },
      { open: "<市区町村名>", close: "</市区町村名>", kind: "meta" },
    ];
    this.maxToken = Math.max(...this.tokens.map((t) => t.open.length));
    return true;
  }

  /**
   * 溜まった文字列から、読み取れる要素を全部読む。
   * 「<」ごとに見て、目当ての要素の始まりなら終わりの札まで切り出す。目当てでなければ次の「<」へ。
   * 目当ての要素の中は丸ごと飛ばすので、入れ子の札は数えない
   */
  private drain(final: boolean) {
    if (!this.settle(final)) return;
    const buf = this.buf;
    let pos = 0;
    for (;;) {
      const lt = buf.indexOf("<", pos);
      if (lt < 0) {
        pos = buf.length;
        break;
      }
      // 札の名前が途中で切れているかもしれない。次の push を待つ
      if (!final && buf.length - lt < this.maxToken) {
        pos = lt;
        break;
      }
      let tok: (typeof this.tokens)[number] | null = null;
      for (const t of this.tokens) {
        if (buf.startsWith(t.open, lt)) {
          tok = t;
          break;
        }
      }
      if (!tok) {
        pos = lt + 1;
        continue;
      }
      const end = buf.indexOf(tok.close, lt + tok.open.length);
      if (end < 0) {
        if (final) {
          pos = buf.length; // 閉じていない要素は捨てる
          break;
        }
        pos = lt;
        break;
      }
      const el = buf.slice(lt, end + tok.close.length);
      this.element(tok.kind, el, tok.open.length, tok.close.length);
      pos = end + tok.close.length;
    }
    this.buf = buf.slice(pos);
  }

  private element(kind: "point" | "curve" | "surface" | "fude" | "meta", el: string, openLen: number, closeLen: number) {
    switch (kind) {
      case "point": {
        const id = attr(el, "id");
        const xy = coordsIn(el);
        if (id && xy.length) this.pts.set(id, xy[0]);
        break;
      }
      case "curve": {
        const id = attr(el, "id");
        if (!id) break;
        const seq: (string | EN)[] = [];
        // 並びの順を守るため、参照と直接の座標を 1 本の正規表現で拾う
        const re = /<(?:[\w.-]+:)?GM_PointRef\.point\s+idref="([^"]+)"|<(?:[\w.-]+:)?X>\s*([-\d.eE+]+)\s*<\/(?:[\w.-]+:)?X>\s*<(?:[\w.-]+:)?Y>\s*([-\d.eE+]+)\s*<\/(?:[\w.-]+:)?Y>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(el))) {
          if (m[1]) seq.push(m[1]);
          else seq.push([Number(m[3]), Number(m[2])]); // X=北、Y=東 → EN=[東, 北]
        }
        this.curves.set(id, seq);
        break;
      }
      case "surface": {
        const id = attr(el, "id");
        if (!id) break;
        const ext = generatorsIn(sectionIn(el, "GM_SurfaceBoundary.exterior"));
        const holes: string[][] = [];
        const re = /<(?:[\w.-]+:)?GM_SurfaceBoundary\.interior>([\s\S]*?)<\/(?:[\w.-]+:)?GM_SurfaceBoundary\.interior>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(el))) holes.push(generatorsIn(m[1]));
        this.surfs.set(id, { ext, holes });
        break;
      }
      case "fude": {
        const id = attr(el.slice(0, el.indexOf(">") + 1), "id") ?? `H${this.fude.length + 1}`;
        const shape = /<形状\s+idref="([^"]+)"/.exec(el);
        this.fude.push({
          id,
          oaza: textIn(el, "大字名"),
          chiban: textIn(el, "地番") ?? "",
          shape: shape ? shape[1] : null,
          accuracy: textIn(el, "精度区分"),
          survey: textIn(el, "座標値種別"),
        });
        break;
      }
      case "meta": {
        const name = el.slice(1, el.indexOf(">"));
        this.meta[name] = unescapeXml(el.slice(openLen, el.length - closeLen).trim());
        break;
      }
    }
  }

  /** 線の並びをつないで 1 つの輪にする。つなぎ目の重なる点は 1 つにし、向きが逆の線は裏返す */
  private ring(curveIds: string[]): EN[] {
    const out: EN[] = [];
    for (const cid of curveIds) {
      const raw = this.curves.get(cid);
      if (!raw) continue;
      let seq: EN[] = [];
      for (const c of raw) {
        const p = typeof c === "string" ? this.pts.get(c) : c;
        if (p) seq.push(p);
      }
      if (!seq.length) continue;
      if (out.length) {
        const last = out[out.length - 1];
        if (!same(last, seq[0]) && same(last, seq[seq.length - 1])) seq = seq.slice().reverse();
        if (same(last, seq[0])) seq = seq.slice(1);
      }
      out.push(...seq);
    }
    if (out.length && !same(out[0], out[out.length - 1])) out.push(out[0]);
    return out;
  }
}

function same(a: EN, b: EN): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function attr(el: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(el);
  return m ? m[1] : null;
}

function textIn(el: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(el);
  return m ? unescapeXml(m[1].trim()) : null;
}

function coordsIn(el: string): EN[] {
  const out: EN[] = [];
  const re = /<(?:[\w.-]+:)?X>\s*([-\d.eE+]+)\s*<\/(?:[\w.-]+:)?X>\s*<(?:[\w.-]+:)?Y>\s*([-\d.eE+]+)\s*<\/(?:[\w.-]+:)?Y>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(el))) out.push([Number(m[2]), Number(m[1])]);
  return out;
}

function sectionIn(el: string, tag: string): string {
  const m = new RegExp(`<(?:[\\w.-]+:)?${tag.replace(".", "\\.")}>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag.replace(".", "\\.")}>`).exec(el);
  return m ? m[1] : "";
}

function generatorsIn(s: string): string[] {
  const out: string[] = [];
  const re = /<(?:[\w.-]+:)?GM_CompositeCurve\.generator\s+idref="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1]);
  return out;
}

/** 文字列を一度に読む（テストや小さなファイル用） */
export function parseMojxml(text: string, fileName: string): MojMap {
  const p = new MojxmlParser(fileName);
  p.push(text);
  return p.end();
}

/**
 * 筆の外周のどこかが中心線の bufferM 以内にあれば「近い」。
 * 大きな筆（地区外など）は点が粗いので、辺の途中も 20m ごとに補って見る（前処理と同じ）。
 * 距離は 1m ごとの中心線の点までの距離で測る（折れ線そのものまでの距離より最大 0.5m 大きいだけ）
 */
export function nearLine(ring: EN[], index: StationIndex, lineBbox: [number, number, number, number], bufferM: number): boolean {
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const [e, n] of ring) {
    if (e < minE) minE = e;
    if (e > maxE) maxE = e;
    if (n < minN) minN = n;
    if (n > maxN) maxN = n;
  }
  if (maxE < lineBbox[0] - bufferM || minE > lineBbox[2] + bufferM || maxN < lineBbox[1] - bufferM || minN > lineBbox[3] + bufferM) return false;
  const test = (p: EN) => index.nearest(p, bufferM) !== null;
  if (test(ring[0])) return true;
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i - 1];
    const q = ring[i];
    const n = Math.floor(Math.hypot(q[0] - p[0], q[1] - p[1]) / 20);
    for (let k = 1; k <= n; k++) {
      if (test([p[0] + ((q[0] - p[0]) * k) / (n + 1), p[1] + ((q[1] - p[1]) * k) / (n + 1)])) return true;
    }
    if (test(q)) return true;
  }
  return false;
}

export function lineBboxOf(dense: EN[]): [number, number, number, number] {
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const [e, n] of dense) {
    if (e < minE) minE = e;
    if (e > maxE) maxE = e;
    if (n < minN) minN = n;
    if (n > maxN) maxN = n;
  }
  return [minE, minN, maxE, maxN];
}

/**
 * 1 枚の地図から、区間の周り（両側 bufferM）の筆だけを緯度経度の GeoJSON にする。
 * id は「ファイル名:筆の id」（前処理と同じ）。見本の判定や保存した値と同じ筆を同じ名前で指せるように
 */
export function cutParcels(map: MojMap, dense: EN[], bufferM = 200, index = new StationIndex(dense), bbox = lineBboxOf(dense)): ParcelFeature[] {
  if (!map.isPublic) return [];
  const out: ParcelFeature[] = [];
  for (const p of map.parcels) {
    if (!nearLine(p.rings[0], index, bbox, bufferM)) continue;
    out.push({
      type: "Feature",
      properties: { id: `${map.stem}:${p.id}`, map: map.stem, oaza: p.oaza, chiban: p.chiban, kind: p.kind, accuracy: p.accuracy, survey: p.survey } as ParcelFeature["properties"],
      geometry: { type: "Polygon", coordinates: p.rings.map((r) => r.map((en) => toLonLat(en).map((v) => Math.round(v * 1e7) / 1e7))) },
    });
  }
  return out;
}
