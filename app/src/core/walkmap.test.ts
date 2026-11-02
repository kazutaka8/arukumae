import { describe, expect, it } from "vitest";
import { fitFrame } from "./walkmap";

describe("持って歩く地図：枠に収める", () => {
  it("横長の範囲は幅で縮尺が決まり、上下に余りが出て真ん中に置かれる", () => {
    const box = { x: 10, y: 10, w: 100, h: 100 }; // mm → 800×800 px
    const f = fitFrame(box, [0, 0, 400, 100], 36.6);
    expect(f.scale).toBe(2); // 800 / 400
    expect(f.minX).toBe(0);
    expect(f.minY).toBe(-150); // 高さ 400 px 分の内、範囲 100 の余り 300 の半分
    expect(f.metersPerPagePx).toBeGreaterThan(0);
  });
  it("縦長の範囲は高さで決まる", () => {
    const f = fitFrame({ x: 0, y: 0, w: 100, h: 50 }, [0, 0, 100, 400], 36.6);
    expect(f.scale).toBe(1); // 400 / 400
    expect(f.minX).toBe(-350);
  });
});
