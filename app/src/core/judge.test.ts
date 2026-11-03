import { describe, expect, it } from "vitest";
import { parseAnswer } from "./judge";

/** 答えの番号の過不足（spec §8.4・§10）。課金しない模擬の答えで確かめる */
describe("parseAnswer", () => {
  const ok = (id: string, tree = 75) => ({ id, tree, kind: "針葉樹", other: ["道路"], conf: "中", why: "林冠" });

  it("頼んだ番号がそろっていれば missing は空", () => {
    const r = parseAnswer(JSON.stringify({ segments: [ok("L001"), ok("R001")] }), ["L001", "R001"], "m");
    expect(r.judgments.map((j) => j.segmentId)).toEqual(["L001", "R001"]);
    expect(r.judgments[0]).toMatchObject({ tree: 75, kind: "針葉樹", conf: "中", by: "Claude", model: "m" });
    expect(r.missing).toEqual([]);
  });

  it("欠けた番号は missing に。頼んでいない番号は捨て、同じ番号は最初のものを使う", () => {
    const r = parseAnswer(JSON.stringify({ segments: [ok("L001", 25), ok("L001", 100), ok("L009")] }), ["L001", "R001"], "m");
    expect(r.judgments.map((j) => [j.segmentId, j.tree])).toEqual([["L001", 25]]);
    expect(r.missing).toEqual(["R001"]);
  });

  it("選択肢にない値は保存せず、その番号を missing に入れる。壊れた JSON は全部 missing", () => {
    const bad = { ...ok("L001"), kind: "<img onerror=x>" };
    const r = parseAnswer(JSON.stringify({ segments: [bad, ok("R001")] }), ["L001", "R001"], "m");
    expect(r.judgments.map((j) => j.segmentId)).toEqual(["R001"]);
    expect(r.missing).toEqual(["L001"]);
    expect(parseAnswer("{", ["L001"], "m")).toEqual({ judgments: [], missing: ["L001"] });
    expect(parseAnswer(JSON.stringify({ segments: [{ ...ok("L001"), tree: 30 }] }), ["L001"], "m").missing).toEqual(["L001"]);
  });

  it("別の年の写真つきなら treeOld と change も要る", () => {
    const two = { ...ok("L001"), treeOld: 100, change: "木が減った" };
    const r = parseAnswer(JSON.stringify({ segments: [two, ok("R001")] }), ["L001", "R001"], "m", "2019");
    expect(r.judgments.map((j) => j.segmentId)).toEqual(["L001"]);
    expect(r.judgments[0]).toMatchObject({ oldYear: "2019", treeOld: 100, change: "木が減った" });
    expect(r.missing).toEqual(["R001"]);
  });
});
