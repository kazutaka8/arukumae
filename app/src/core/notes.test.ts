import { describe, expect, it } from "vitest";
import { countNotes, noteText, notesText, pruneNotes, type FieldNote } from "./notes";

const n = (segmentId: string, result: FieldNote["result"], memo = ""): [string, FieldNote] => [segmentId, { segmentId, result, memo, at: "2026-11-03T10:00:00Z" }];

describe("現地の記録", () => {
  it("言葉にする：結果だけ、結果とメモ、メモだけ、空", () => {
    expect(noteText(n("L001", "○")[1])).toBe("○");
    expect(noteText(n("L001", "×", "電線あり。立てられない")[1])).toBe("×：電線あり。立てられない");
    expect(noteText(n("L001", "", "写真より木が多い")[1])).toBe("メモ：写真より木が多い");
    expect(noteText(n("L001", "")[1])).toBe("");
    expect(noteText(undefined)).toBe("");
  });

  it("筆のぶんはまとめ、記録のない区切りは飛ばす", () => {
    const notes = new Map([n("L003", "×", "電線あり"), n("L004", "○"), n("L005", "")]);
    expect(notesText(notes, ["L003", "L004", "L005", "L006"])).toBe("L003 ×：電線あり ／ L004 ○");
    expect(notesText(notes, ["L006"])).toBe("");
  });

  it("空の記録は保存しない。数えるときも数えない", () => {
    const notes = new Map([n("L003", "×", "電線あり"), n("L004", "○"), n("L005", ""), n("L006", "", "  ")]);
    expect(pruneNotes(notes).map((x) => x.segmentId)).toEqual(["L003", "L004"]);
    const c = countNotes(notes, ["L003", "L005", "R010"]);
    expect(c.total).toBe(2);
    expect(c.byResult).toEqual({ "○": 1, "△": 0, "×": 1 });
    expect(c.checksDone).toBe(1);
  });
});
