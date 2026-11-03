/**
 * 見本のデータ（長野県小川村 県道401号）。初めて開いたとき、鍵がなくても全部の手順を触れるようにする。
 *
 * - 区間の線・筆：リポジトリの data/ogawa/（出典はそれぞれのファイルと data/README.md）
 * - 判定の見本：experiments/case_c/ で Claude（Sonnet 5.5）が判定した結果。
 *   2026-11-03 から、既定の車両（ブレードリフター・寝かせたまま）で道具が作る区切りの形で取り直したもの（*_vehicle_sonnet_1）。
 *   初日の試し（A_sonnet_1・B_sonnet_1）は幅 13m の固定の帯で判定していて、道具の区切り（カーブの外側で幅 45m）と形が違い、
 *   森ばかりの区切りに「草地が主体 25%」が付いていた（触ってもらって分かった）
 * ファイルはビルドのときに同梱される（import.meta.url で参照）。
 */
import type { FeatureCollection, LineString, Polygon } from "geojson";
import type { Judgment, ParcelProps } from "../core/types";

const sectionUrl = new URL("../../../data/ogawa/section.geojson", import.meta.url).href;
const parcelsUrl = new URL("../../../data/ogawa/parcels.geojson", import.meta.url).href;
const judgmentUrls = [
  new URL("../../../experiments/case_c/out/results/A_vehicle_sonnet_1.json", import.meta.url).href,
  new URL("../../../experiments/case_c/out/results/B_vehicle_sonnet_1.json", import.meta.url).href,
];

export interface SectionProps {
  name: string;
  road_name: string;
  road_ref: string;
  length_m: number;
  source: string;
}

export async function loadSection(): Promise<FeatureCollection<LineString, SectionProps>> {
  return (await fetch(sectionUrl)).json();
}

export async function loadParcels(): Promise<FeatureCollection<Polygon, ParcelProps> & { source?: string }> {
  return (await fetch(parcelsUrl)).json();
}

interface ExperimentResult {
  model: string;
  segments: { id: string; tree: number; kind: Judgment["kind"]; other: string[]; conf: Judgment["conf"]; why: string }[];
}

export async function loadDemoJudgments(): Promise<Judgment[]> {
  const out: Judgment[] = [];
  for (const url of judgmentUrls) {
    const r: ExperimentResult = await (await fetch(url)).json();
    for (const s of r.segments) {
      out.push({ segmentId: s.id, tree: s.tree, kind: s.kind, other: s.other, conf: s.conf, why: s.why, by: "Claude", model: r.model });
    }
  }
  return out;
}
