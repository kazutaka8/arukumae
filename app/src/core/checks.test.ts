import { describe, expect, it } from "vitest";
import { checkKindText, checkText, listChecks, treeText } from "./checks";
import { buildSegments, leftNormals, resample } from "./geom";
import type { EN } from "./proj";
import type { Judgment } from "./types";

const j = (segmentId: string, patch: Partial<Judgment> = {}): Judgment => ({ segmentId, tree: 50, kind: "広葉樹", other: [], conf: "中", why: "理由", by: "Claude", ...patch });

describe("現地で確かめる所", () => {
  const dense = resample([[0, 0], [40, 0]] as EN[], 1);
  const segs = buildSegments(dense, leftNormals(dense), { step: 10, roadHalf: 3, bandOut: 10 });

  it("確信 低・森林の食い違い・別の年の写真との変化の 3 つが並ぶ。「変化なし」と「分からない」は入れない", () => {
    const judgments = new Map<string, Judgment>([
      ["L000", j("L000", { conf: "低" })],
      ["L001", j("L001", { oldYear: "2022", treeOld: 100, change: "木が減った", tree: 0 })],
      ["L002", j("L002", { oldYear: "2022", treeOld: 50, change: "変化なし" })],
      ["L003", j("L003", { oldYear: "2022", treeOld: 50, change: "分からない" })],
      ["R000", j("R000")],
    ]);
    const forest = new Map([["R000", "区域の中なのに木が 25% 以下"]]);
    const out = listChecks(segs, judgments, forest);
    expect(out.map((c) => `${c.segmentId}:${c.kind}`)).toEqual(["L000:低", "R000:森林", "L001:変化"]);
    expect(out[2].why).toContain("2022 年度の写真と比べて「木が減った」（当時 100% → 今 0%）");
    expect(checkText(out)).toContain("L001（変化）：");
    expect(checkKindText("変化")).toContain("別の年の写真");
  });

  it("Claude の答えに番号がなかった区切りは、未判定のまま並ぶ（tree は null）。判定が付けば消える", () => {
    const judgments = new Map<string, Judgment>([["L000", j("L000")]]);
    const unjudged = new Set(["L000", "R001"]);
    const out = listChecks(segs, judgments, null, unjudged);
    expect(out.map((c) => `${c.segmentId}:${c.kind}:${c.tree}`)).toEqual(["R001:未判定:null"]);
    expect(treeText(out[0].tree)).toBe("—");
    expect(treeText(25)).toBe("25%");
    expect(checkKindText("未判定")).toContain("判定なし");
    expect(listChecks(segs, judgments, null, null)).toEqual([]);
  });
});
