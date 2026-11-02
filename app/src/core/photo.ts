/**
 * 区切りの窓（200m ほど）の航空写真を、札なし・札ありの2枚の JPEG にする（spec §8.4）。
 * 試し（experiments/case_c/segments.py の crop）で Claude がよく読めた作り方をそのまま移した：
 * 地理院の全国最新写真（z18、約 0.48m／画素）を3倍に拡大し、札ありには区切りの枠（左＝黄、右＝水色）と番号を描く。
 * 送るのは写真と区切りの番号だけで、座標や地名は画像に入れない（spec §8.7）。
 */
import type { Segment } from "./geom";
import { toLonLat } from "./proj";

export const Z = 18;
export const TILE = 256;
const SCALE = 3;
const PAD_M = 15;
/** 番号の札を、枠の道路側の縁から道路へ何 m 入れて置くか（道路の半幅 3m の半分） */
const LABEL_IN_M = 1.5;
const TILE_URL = (z: number, x: number, y: number) => `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`;

export interface WindowImages {
  ids: string[];
  /** JPEG の base64（data: の頭は付けない） */
  plain: string;
  labeled: string;
  width: number;
  height: number;
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

// タイルの写しはページを開いている間だけ持つ。同じ窓を判定し直すときに、もう一度取りに行かないため
const tileCache = new Map<string, Promise<ImageBitmap | null>>();

export function fetchTile(z: number, x: number, y: number): Promise<ImageBitmap | null> {
  const key = `${z}/${x}/${y}`;
  let p = tileCache.get(key);
  if (!p) {
    p = fetch(TILE_URL(z, x, y))
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? createImageBitmap(b) : null))
      .catch(() => null); // 写真のない所（海など）は黒のまま。判定は「低」になるだけで、止めない
    tileCache.set(key, p);
  }
  return p;
}

/** 区切りの集まりを、札なし・札ありの画像にする */
export async function renderWindow(segs: Segment[]): Promise<WindowImages> {
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
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      jobs.push(
        fetchTile(Z, tx, ty).then((img) => {
          if (img) ctx.drawImage(img, (tx * TILE - minX) * SCALE, (ty * TILE - minY) * SCALE, TILE * SCALE, TILE * SCALE);
        }),
      );
    }
  }
  await Promise.all(jobs);
  const plain = toJpeg(canvas);

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
  const labeled = toJpeg(canvas);
  return { ids: segs.map((s) => s.id), plain, labeled, width: w, height: h };
}

function toJpeg(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/jpeg", 0.9).split(",")[1];
}

/**
 * 区切りを「窓」に分ける。1窓は左右あわせて最大 maxPairs×2 区切り（既定 20 対＝200m。試しで Claude が40区切りを1回で読めた大きさ）。
 * 窓の数を先に決めてから均等に割る。端から 200m ずつ切ると最後の窓だけ 50m になり、写真が狭くて札が読みにくいため
 */
export function windowsOf(segments: Segment[], maxPairs = 20): Segment[][] {
  // 「対」は同じ起点からの距離の左右。軌跡図によっては片側しかない所があるので、区切りの数ではなく距離の種類で数える
  const stations = [...new Set(segments.map((s) => s.fromM))].sort((a, b) => a - b);
  const n = Math.max(1, Math.ceil(stations.length / maxPairs));
  const per = Math.ceil(stations.length / n);
  const out: Segment[][] = [];
  for (let i = 0; i < stations.length; i += per) {
    const group = new Set(stations.slice(i, i + per));
    const w = segments.filter((s) => group.has(s.fromM));
    if (w.length) out.push(w);
  }
  return out;
}
