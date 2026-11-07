import { describe, expect, it } from "vitest";
import type { Segment } from "./geom";
import { clearTileCache, fetchTile, LATEST, PHOTO_YEARS, photoLayerLabel, photoTileTemplate, photoTileUrl, windowsOf } from "./photo";

function fakeSegments(pairs: number): Segment[] {
  const out: Segment[] = [];
  for (let k = 0; k < pairs; k++) {
    for (const side of ["L", "R"] as const) {
      out.push({ id: `${side}${String(k).padStart(3, "0")}`, side, fromM: k * 10, toM: k * 10 + 10, ring: [], areaM2: 100, outerMaxM: 13 });
    }
  }
  return out;
}

describe("写真のタイルの写し（Codex の指摘 2026-11-06・07）", () => {
  it("取得の失敗（404 以外）は覚えずに取り直す。写真の無い所（404）は覚えて取り直さない", async () => {
    clearTileCache();
    const calls: string[] = [];
    let fail = true;
    const doFetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).includes("/1/")) return new Response(null, { status: 404 });
      if (fail) return new Response(null, { status: 503 });
      throw new Error("ここまでは来ない（成功の経路は createImageBitmap が要るので試さない）");
    }) as typeof fetch;
    expect(await fetchTile(18, 0, 0, "seamlessphoto", doFetch)).toBeNull(); // 503：失敗
    expect(await fetchTile(18, 0, 0, "seamlessphoto", doFetch)).toBeNull(); // 取り直す（覚えていない）
    expect(calls.filter((u) => u.includes("/0/0")).length).toBe(2);
    fail = false;
    expect(await fetchTile(18, 1, 0, "seamlessphoto", doFetch)).toBeNull(); // 404：写真が無い
    expect(await fetchTile(18, 1, 0, "seamlessphoto", doFetch)).toBeNull();
    expect(calls.filter((u) => u.includes("/1/0")).length).toBe(1); // 覚えているので 1 回だけ
    clearTileCache();
  });
});

describe("windowsOf", () => {
  it("145 対（1.45km）は 8 窓に均等に割れ、最後の窓だけ小さくならない", () => {
    const w = windowsOf(fakeSegments(145));
    expect(w).toHaveLength(8);
    expect(w.map((x) => x.length)).toEqual([38, 38, 38, 38, 38, 38, 38, 24]);
    expect(w.flat().map((s) => s.id)).toEqual(fakeSegments(145).map((s) => s.id)); // 順も漏れも変わらない
    for (const x of w) expect(x.length % 2).toBe(0); // 左右がそろう
  });

  it("片側しかない所があっても、同じ距離の左右は同じ窓に入る", () => {
    const segs = fakeSegments(30).filter((s) => !(s.side === "R" && s.fromM >= 100 && s.fromM < 200)); // 100〜200m は左だけ
    const w = windowsOf(segs, 10);
    expect(w).toHaveLength(3);
    expect(w[1].map((s) => s.id)).toEqual(["L010", "L011", "L012", "L013", "L014", "L015", "L016", "L017", "L018", "L019"]);
    expect(w[2].length).toBe(20);
  });

  it("写真の層：最新は全国最新写真、4 桁の年は年度別写真。年の候補は去年から 2007 年まで", () => {
    expect(photoTileUrl(LATEST, 18, 1, 2)).toBe("https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/18/1/2.jpg");
    expect(photoTileUrl("2022", 18, 1, 2)).toBe("https://cyberjapandata.gsi.go.jp/xyz/nendophoto2022/18/1/2.png");
    expect(photoTileTemplate("2022")).toBe("https://cyberjapandata.gsi.go.jp/xyz/nendophoto2022/{z}/{x}/{y}.png");
    expect(PHOTO_YEARS[0]).toBe(String(new Date().getFullYear() - 1));
    expect(PHOTO_YEARS.at(-1)).toBe("2007");
    expect(photoLayerLabel("2022")).toBe("2022 年度の写真");
  });

  it("20 対までなら 1 窓", () => {
    expect(windowsOf(fakeSegments(20))).toHaveLength(1);
    expect(windowsOf(fakeSegments(21))).toHaveLength(2);
  });

  it("区切りが途切れた所では窓を分ける（曲がりだけを描いた軌跡図。Codex の指摘 2026-11-06：8km 離れた 2 か所が 1 窓になった）", () => {
    const all = fakeSegments(810);
    const segs = all.filter((s) => s.fromM < 50 || s.fromM >= 8000); // 0〜50m と 8,000〜8,100m だけ
    const w = windowsOf(segs);
    expect(w).toHaveLength(2);
    expect(w.map((x) => [x[0].fromM, x.at(-1)!.toM])).toEqual([[0, 50], [8000, 8100]]);
    expect(w.flat()).toHaveLength(segs.length); // 漏れない
    for (const x of w) expect(x.at(-1)!.toM - x[0].fromM).toBeLessThanOrEqual(200); // 1 窓は 200m まで
  });

  it("潰れた区切りを隣と合わせた所（20〜30m 空く）では分けない", () => {
    const segs = fakeSegments(20).filter((s) => s.fromM !== 60 && s.fromM !== 70); // 60〜80m が合わさって抜けた形
    expect(windowsOf(segs)).toHaveLength(1);
  });
});
