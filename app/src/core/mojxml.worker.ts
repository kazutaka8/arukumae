/**
 * 公図（地図XML の zip）を読むワーカー。170MB の XML を読む数秒のあいだ、地図と画面を固まらせないために別の糸で動かす。
 * 受け取るのはファイルと、区間の中心線（1m ごとの平面座標）と、残す幅。返すのは区間の周りの筆の GeoJSON と、地図ごとの報告。
 * ファイルの中身はこのワーカーの外（端末の外）へ出さない
 */
import { StationIndex } from "./geom";
import { cutParcels, lineBboxOf, type MojMap } from "./mojxml";
import { createMojReader } from "./mojzip";
import type { ParcelFeature } from "./parcels";
import type { EN } from "./proj";

export interface MapReport {
  stem: string;
  name: string;
  city: string;
  crs: string;
  isPublic: boolean;
  /** 地図の中の筆の数 */
  total: number;
  /** 区間の周りに残した筆の数 */
  kept: number;
  noShape: number;
}

export type WorkerIn = { file: File; dense: EN[]; bufferM: number };
export type WorkerOut =
  | { type: "progress"; bytes: number; total: number; maps: number; kept: number; current: string | null }
  | { type: "done"; features: ParcelFeature[]; maps: MapReport[]; skipped: string[]; ms: number }
  | { type: "error"; message: string };

const post = (m: WorkerOut) => (globalThis as unknown as { postMessage(m: unknown): void }).postMessage(m);

(globalThis as unknown as { onmessage: (e: MessageEvent<WorkerIn>) => void }).onmessage = async (e) => {
  const { file, dense, bufferM } = e.data;
  const t0 = performance.now();
  try {
    const index = new StationIndex(dense);
    const bbox = lineBboxOf(dense);
    const features: ParcelFeature[] = [];
    const maps: MapReport[] = [];
    const skipped: string[] = [];
    let current: string | null = null;
    let bytes = 0;
    let lastPost = 0;
    const progress = (force = false) => {
      const now = performance.now();
      if (!force && now - lastPost < 150) return;
      lastPost = now;
      post({ type: "progress", bytes, total: file.size, maps: maps.length, kept: features.length, current });
    };
    const reader = createMojReader(file.name, {
      onStart: (name) => {
        current = name;
        progress(true);
      },
      onMap: (m: MojMap) => {
        const cut = cutParcels(m, dense, bufferM, index, bbox);
        features.push(...cut);
        maps.push({ stem: m.stem, name: m.name, city: m.city, crs: m.crs, isPublic: m.isPublic, total: m.parcels.length, kept: cut.length, noShape: m.noShape });
        current = null;
        progress(true);
      },
      onSkip: (name) => skipped.push(name),
    });
    const stream = file.stream().getReader();
    for (;;) {
      const { value, done } = await stream.read();
      if (done) break;
      bytes += value.length;
      reader.push(value, false);
      progress();
    }
    reader.push(new Uint8Array(0), true);
    post({ type: "done", features, maps, skipped, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    post({ type: "error", message: (err as Error).message || String(err) });
  }
};
