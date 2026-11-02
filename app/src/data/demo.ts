/**
 * 見本のデータ（長野県小川村 県道401号）。初めて開いたとき、鍵がなくても全部の手順を触れるようにする。
 *
 * - 区間の線・筆：リポジトリの data/ogawa/（出典はそれぞれのファイルと data/README.md）
 * - 判定の見本：experiments/case_c/ で Claude（Sonnet 5.5）が判定した結果の1回目
 * ファイルはビルドのときに同梱される（import.meta.url で参照）。
 */
import type { FeatureCollection, LineString, Polygon } from "geojson";
import type { Judgment, ParcelProps } from "../core/types";

const sectionUrl = new URL("../../../data/ogawa/section.geojson", import.meta.url).href;
const parcelsUrl = new URL("../../../data/ogawa/parcels.geojson", import.meta.url).href;
const judgmentUrls = [
  new URL("../../../experiments/case_c/out/results/A_sonnet_1.json", import.meta.url).href,
  new URL("../../../experiments/case_c/out/results/B_sonnet_1.json", import.meta.url).href,
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
