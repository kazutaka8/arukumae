/**
 * 区切りの窓（200m ほど）の航空写真を、札なし・札ありの2枚の JPEG にする（spec §8.4）。
 * 試し（experiments/case_c/segments.py の crop）で Claude がよく読めた作り方をそのまま移した：
 * 地理院の全国最新写真（z18、約 0.48m／画素）を3倍に拡大し、札ありには区切りの枠（左＝黄、右＝水色）と番号を描く。
 * 送るのは写真と区切りの番号だけで、座標や地名は画像に入れない（spec §8.7）。
 * 写真は地理院の「全国最新写真」のほか、「年度別写真」（2007 年以降。ある年と場所だけ）も選べる（2026-11-03）。
 * Google の航空写真は、規約で画像の解析や機械による解釈が禁じられているので使わない（自分の理解。docs/spec.md §8.4）
 */
import type { Segment } from "./geom";
import { toLonLat } from "./proj";

export const Z = 18;
export const TILE = 256;
const SCALE = 3;
const PAD_M = 15;
/** 番号の札を、枠の道路側の縁から道路へ何 m 入れて置くか（道路の半幅 3m の半分） */
const LABEL_IN_M = 1.5;
/** 写真の層の id。"latest" が全国最新写真、"2022" のような 4 桁が年度別写真（nendophoto2022） */
export type PhotoLayer = string;
export const LATEST: PhotoLayer = "latest";
/** 年度別写真の年の候補。地理院は 2007 年以降を配っている（場所によって無い年がある） */
export const PHOTO_YEARS: string[] = Array.from({ length: new Date().getFullYear() - 2007 }, (_, i) => String(new Date().getFullYear() - 1 - i));

export function photoTileUrl(layer: PhotoLayer, z: number, x: number, y: number): string {
  return layer === LATEST ? `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg` : `https://cyberjapandata.gsi.go.jp/xyz/nendophoto${layer}/${z}/${x}/${y}.png`;
}

/** 地図のソースに渡す形（{z}/{x}/{y} のまま） */
export function photoTileTemplate(layer: PhotoLayer): string {
  return photoTileUrl(layer, "{z}" as unknown as number, "{x}" as unknown as number, "{y}" as unknown as number);
}

export function photoLayerLabel(layer: PhotoLayer): string {
  return layer === LATEST ? "全国最新写真" : `${layer} 年度の写真`;
}

export interface WindowImages {
  ids: string[];
  /** JPEG の base64（data: の頭は付けない） */
  plain: string;
  labeled: string;
  width: number;
  height: number;
  /** どの写真か（全国最新写真・年度別）。年度別で写真のないタイルが混じるかどうかの手がかりに coverage も持つ */
  layer: PhotoLayer;
  /** 取れたタイル ÷ 必要なタイル（0〜1）。0 ならその年の写真がこの窓にない */
  coverage: number;
}

export function lonLatToPx(lon: number, lat: number, z = Z): [number, number] {
  const n = 2 ** z * TILE;
  const x = ((lon + 180) / 360) * n;
  const y = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  return [x, y];
}

/** 1画素が何 m か（その緯度で） */
export function metersPerPx(lat: number, z = Z): number {
  return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (2 ** z * TILE);
}

// タイルの写しはページを開いている間だけ持つ。同じ窓を判定し直すときに、もう一度取りに行かないため。
// 写真が元から無い所（海など。HTTP 404）は null として覚える。取得の失敗（通信が切れた・取得先が一時的に止まった・それ以外の HTTP の誤り）は
// 覚えずに写しから外し、次に要るときに取り直す（2026-11-07。Codex の指摘 2026-11-06・07：失敗を覚えたまま、欠けた写真で判定に送っていた）。
// 欠けた窓を判定に送らないのは main.ts の runJudging（coverage が半分未満なら送らない）
const tileCache = new Map<string, Promise<ImageBitmap | null>>();

export function fetchTile(z: number, x: number, y: number, layer: PhotoLayer = LATEST, doFetch: typeof fetch = fetch): Promise<ImageBitmap | null> {
  const key = `${layer}/${z}/${x}/${y}`;
  let p = tileCache.get(key);
  if (!p) {
    p = doFetch(photoTileUrl(layer, z, x, y))
      .then(async (r) => {
        if (r.status === 404) return null; // 写真のない所（海など）は黒のまま。判定は「低」になるだけで、止めない
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return createImageBitmap(await r.blob());
      })
      .catch(() => {
        tileCache.delete(key);
        return null;
      });
    tileCache.set(key, p);
  }
  return p;
}

/** 試験用：写しを空にする */
export function clearTileCache() {
  tileCache.clear();
}

/** 区切りの集まりを、札なし・札ありの画像にする */
export async function renderWindow(segs: Segment[], layer: PhotoLayer = LATEST): Promise<WindowImages> {
  const r = await renderWindowCanvases(segs, layer);
  return { ids: segs.map((s) => s.id), plain: toJpeg(r.plain), labeled: toJpeg(r.labeled), width: r.plain.width, height: r.plain.height, layer, coverage: r.coverage };
}

/**
 * 1 つの区切りの周り（pad m）を、窓の画像（札なし・札あり）から切り抜く。詳細パネルで「Claude が見たもの」を見せる用。
 * 判定に送った画像と同じ描き方なので、札の位置や枠も同じ
 */
export async function renderSegmentCrop(windowSegs: Segment[], focusId: string, padM = 25, layer: PhotoLayer = LATEST): Promise<{ plain: string; labeled: string; width: number; height: number } | null> {
  const focus = windowSegs.find((s) => s.id === focusId);
  if (!focus) return null;
  const r = await renderWindowCanvases(windowSegs, layer);
  const pts = focus.ring.map((p) => r.px(lonLatToPx(...toLonLat(p))));
  const lat = toLonLat(focus.ring[0])[1];
  const pad = (padM / metersPerPx(lat)) * SCALE;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  // 正方形に近い切り抜きにする（細長い区切りでも周りが見えるように）
  const size = Math.max(maxX - minX, maxY - minY) + 2 * pad;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const sx = Math.max(0, Math.round(cx - size / 2));
  const sy = Math.max(0, Math.round(cy - size / 2));
  const w = Math.min(r.plain.width - sx, Math.round(size));
  const h = Math.min(r.plain.height - sy, Math.round(size));
  const crop = (src: HTMLCanvasElement) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d")!.drawImage(src, sx, sy, w, h, 0, 0, w, h);
    return toJpeg(c);
  };
  return { plain: crop(r.plain), labeled: crop(r.labeled), width: w, height: h };
}

/** 窓の 2 枚を canvas のまま返す。px は地図の画素（lonLatToPx）→ 画像の画素 */
async function renderWindowCanvases(segs: Segment[], layer: PhotoLayer = LATEST): Promise<{ plain: HTMLCanvasElement; labeled: HTMLCanvasElement; px: (p: [number, number]) => [number, number]; coverage: number }> {
  const rings = segs.map((s) => s.ring.map((p) => lonLatToPx(...toLonLat(p))));
  const lat = toLonLat(segs[0].ring[0])[1];
  const pad = PAD_M / metersPerPx(lat);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) for (const [x, y] of r) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const w = Math.ceil((maxX - minX) * SCALE);
  const h = Math.ceil((maxY - minY) * SCALE);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const tx0 = Math.floor(minX / TILE), tx1 = Math.floor(maxX / TILE);
  const ty0 = Math.floor(minY / TILE), ty1 = Math.floor(maxY / TILE);
  const jobs: Promise<void>[] = [];
  let got = 0;
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      jobs.push(
        fetchTile(Z, tx, ty, layer).then((img) => {
          if (!img) return;
          got++;
          ctx.drawImage(img, (tx * TILE - minX) * SCALE, (ty * TILE - minY) * SCALE, TILE * SCALE, TILE * SCALE);
        }),
      );
    }
  }
  await Promise.all(jobs);
  const coverage = jobs.length ? got / jobs.length : 0;
  // 札なしは別の canvas に写しておく（この canvas にはこれから札を描く）
  const plainCanvas = document.createElement("canvas");
  plainCanvas.width = w;
  plainCanvas.height = h;
  plainCanvas.getContext("2d")!.drawImage(canvas, 0, 0);

  // 札あり：枠を先に全部、番号は後から全部。番号が隣の枠の線に消されないため
  const px = (p: [number, number]): [number, number] => [(p[0] - minX) * SCALE, (p[1] - minY) * SCALE];
  ctx.lineWidth = 2;
  segs.forEach((s, i) => {
    ctx.strokeStyle = s.side === "L" ? "rgb(255,230,0)" : "rgb(0,220,255)";
    ctx.beginPath();
    rings[i].forEach((p, k) => (k ? ctx.lineTo(...px(p)) : ctx.moveTo(...px(p))));
    ctx.closePath();
    ctx.stroke();
  });
  // 番号の札は枠の中ではなく、道路の側（枠の内側の縁から道路へ 1.5m）に、道に沿って回して置く。
  // 枠の中に置くと細い区切りの地面を隠す。道路の上なら判定の対象ではないので隠れても困らない（2026-11-03）。
  // 外周は「内側の縁（道路側）→ 外側の縁（逆順）」の順（geom.ts の build）なので、前半が道路側
  ctx.font = "bold 14px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const roadPx = (LABEL_IN_M / metersPerPx(lat)) * SCALE;
  segs.forEach((s, i) => {
    const pts = rings[i].slice(0, -1).map(px);
    const n = Math.floor(pts.length / 2);
    const innerMid = pts[Math.floor(n / 2)];
    const outerMid = pts[pts.length - 1 - Math.floor(n / 2)];
    const dx = innerMid[0] - outerMid[0];
    const dy = innerMid[1] - outerMid[1];
    const d = Math.hypot(dx, dy) || 1;
    const cx = innerMid[0] + (dx / d) * roadPx;
    const cy = innerMid[1] + (dy / d) * roadPx;
    // 道の向きに合わせて回す。逆さまにならないよう ±90° に収める
    let angle = Math.atan2(pts[n - 1][1] - pts[0][1], pts[n - 1][0] - pts[0][0]);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.lineWidth = 5;
    ctx.strokeStyle = "black";
    ctx.strokeText(s.id, 0, 0);
    ctx.fillStyle = "white";
    ctx.fillText(s.id, 0, 0);
    ctx.restore();
  });
  return { plain: plainCanvas, labeled: canvas, px, coverage };
}

function toJpeg(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
}

/**
 * 区切りを「窓」に分ける。1窓は左右あわせて最大 maxPairs×2 区切り（既定 20 対＝200m。試しで Claude が40区切りを1回で読めた大きさ）。
 * 窓の数を先に決めてから均等に割る。端から 200m ずつ切ると最後の窓だけ 50m になり、写真が狭くて札が読みにくいため。
 *
 * 区切りが途切れた所（次の区切りまで maxGapM より離れる）では、必ず窓を分ける。曲がりの所だけを描いた軌跡図を読むと、
 * 区切りは曲がりごとの飛び飛びになる。数だけで割ると、数百 m〜数 km 離れた曲がりが 1 枚の写真・PDF の 1 ページにまとまり、
 * 10m の区切りが読めない大きさになった（Codex の指摘 2026-11-06）。潰れた区切りを隣と合わせた所は 20〜30m 空くので、境は 50m
 */
export function windowsOf(segments: Segment[], maxPairs = 20, maxGapM = 50): Segment[][] {
  // 「対」は同じ起点からの距離の左右。軌跡図によっては片側しかない所があるので、区切りの数ではなく距離の種類で数える
  const stations = [...new Set(segments.map((s) => s.fromM))].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const st of stations) {
    const run = runs.at(-1);
    if (run && st - run.at(-1)! <= maxGapM) run.push(st);
    else runs.push([st]);
  }
  const out: Segment[][] = [];
  for (const run of runs) {
    const n = Math.max(1, Math.ceil(run.length / maxPairs));
    const per = Math.ceil(run.length / n);
    for (let i = 0; i < run.length; i += per) {
      const group = new Set(run.slice(i, i + per));
      const w = segments.filter((s) => group.has(s.fromM));
      if (w.length) out.push(w);
    }
  }
  return out;
}
