import { describe, expect, it } from "vitest";
import { buildRows } from "./export";
import { applyMain, applyReview, fixByHuman, idsToJudge, undoFix } from "./judgments";
import type { Judgment, ParcelHit, ParcelProps } from "./types";

/** 人が直した値が Claude の判定より優先される（F10・spec §8.4・§10）。課金しない模擬の答えで、操作の順どおりに確かめる */
const claude = (id: string, tree: number, conf: Judgment["conf"] = "中", model = "sonnet"): Judgment => ({ segmentId: id, tree, kind: "針葉樹", other: ["道路"], conf, why: "林冠", by: "Claude", model });

describe("人が直した判定を、Claude の答えで上書きしない", () => {
  it("Claude の判定を人が直す → 全部を判定し直す → 人の値が残る → 元に戻すと Claude の判定に戻る", () => {
    const judgments = new Map<string, Judgment>([["L001", claude("L001", 25, "低")], ["R001", claude("R001", 75)]]);
    const unjudged = new Set<string>();

    // 人が L001 を直す
    const fixed = fixByHuman(judgments.get("L001"), { segmentId: "L001", tree: 100, kind: "広葉樹", conf: "高", why: " 現地で見た " });
    judgments.set("L001", fixed);
    expect(fixed).toMatchObject({ tree: 100, kind: "広葉樹", conf: "高", why: "現地で見た", by: "人", other: ["道路"] });
    expect(fixed.prev).toMatchObject({ tree: 25, conf: "低", by: "Claude" });

    // 判定し直す：人の区切りは頼まない
    expect(idsToJudge(["L001", "R001"], judgments)).toEqual(["R001"]);
    // それでも答えに L001 が入っていた（頼んだあとに人が直した）としても、上書きしない
    applyMain(judgments, unjudged, { judgments: [claude("L001", 0), claude("R001", 50)], missing: [] });
    expect(judgments.get("L001")).toMatchObject({ tree: 100, by: "人" });
    expect(judgments.get("R001")).toMatchObject({ tree: 50, by: "Claude" });

    // 見直しのモデルの答えも、人の区切りには入れない
    const changed = applyReview(judgments, [claude("L001", 0, "中", "fable"), claude("R001", 100, "中", "fable")]);
    expect(changed).toBe(1);
    expect(judgments.get("L001")).toMatchObject({ tree: 100, by: "人" });
    expect(judgments.get("R001")).toMatchObject({ tree: 100, model: "fable", before: { tree: 50, conf: "中", model: "sonnet" } });

    // 一覧表でも「人」と出る
    const hit: ParcelHit = { parcelId: "p1", areaM2: 100, fromM: 10, toM: 20, sides: ["L"], segmentIds: ["L001"], segAreas: { L001: 100 }, shape: { type: "MultiPolygon", coordinates: [] } };
    const parcels = new Map([["p1", { properties: { id: "p1", map: "m", oaza: "大字稲丘", chiban: "1-1", kind: "ふつう" } as ParcelProps }]]);
    const row = buildRows([hit], parcels, judgments, [], "小川長野線")[0];
    expect(row.決めたのは).toBe("人");
    expect(row.木のある面積m2).toBe(100);

    // 元に戻すと、直す前の Claude の判定
    const back = undoFix(judgments.get("L001"));
    expect(back).toMatchObject({ tree: 25, conf: "低", by: "Claude" });
    expect(back && "prev" in back).toBe(false);
  });

  it("人が 2 回直しても、戻り先は最初の Claude の判定", () => {
    const first = claude("L001", 25);
    const once = fixByHuman(first, { segmentId: "L001", tree: 50, kind: "混じる", conf: "中", why: "" });
    const twice = fixByHuman(once, { segmentId: "L001", tree: 75, kind: "混じる", conf: "高", why: "" });
    expect(once.why).toBe("人が直した"); // 理由が空なら決まった文
    expect(undoFix(twice)).toMatchObject({ tree: 25, by: "Claude" });
  });

  it("未判定の区切りを人が決めたときは、戻す先が無い", () => {
    const fixed = fixByHuman(undefined, { segmentId: "L001", tree: 0, kind: "なし", conf: "高", why: "" });
    expect(fixed.prev).toBeUndefined();
    expect(fixed.other).toEqual([]);
    expect(undoFix(fixed)).toBeNull();
  });

  it("答えに無かった番号は未判定に入れる。前の判定が残っている番号と、人が直した番号は入れない", () => {
    const judgments = new Map<string, Judgment>([["L001", claude("L001", 25)], ["L002", fixByHuman(undefined, { segmentId: "L002", tree: 0, kind: "なし", conf: "高", why: "" })]]);
    const unjudged = new Set<string>(["R001"]);
    applyMain(judgments, unjudged, { judgments: [claude("R001", 75)], missing: ["L001", "L002", "L003"] });
    expect([...unjudged]).toEqual(["L003"]); // R001 は答えが来たので外れ、L003 だけが残る
    expect(judgments.get("L001")?.tree).toBe(25);
  });

  it("見直しは、主の判定が無い区切りには入れない", () => {
    const judgments = new Map<string, Judgment>();
    expect(applyReview(judgments, [claude("L001", 100)])).toBe(0);
    expect(judgments.size).toBe(0);
  });
});
