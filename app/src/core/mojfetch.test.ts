import { describe, expect, it } from "vitest";
import { overpassQuery, parseMunicipalities, pickDataset, samplePoints } from "./mojfetch";

describe("公図の自動取得：市町村を当てる点", () => {
  it("中心線の 100m ごとと両側 200m。1,451m の見本なら 16 か所 × 3", () => {
    // 北へ 1,000m の直線（第VIII系の原点のあたり）
    const pts = samplePoints([[138.5, 36.0], [138.5, 36.009]], 100, 200);
    expect(pts.length).toBe(11 * 3);
    // 左右の点は中心線から 200m 離れている（経度で約 0.0022 度）
    expect(Math.abs(pts[1][0] - 138.5)).toBeGreaterThan(0.002);
    expect(Math.abs(pts[2][0] - 138.5)).toBeGreaterThan(0.002);
    expect(Math.abs(pts[0][0] - 138.5)).toBeLessThan(1e-6);
  });
  it("同じ点は 1 回だけ問い合わせる。admin_level 7・8 の関係を取る", () => {
    const q = overpassQuery([[138.5, 36.0], [138.5, 36.0], [138.6, 36.0]]);
    expect(q.match(/is_in\(/g)!.length).toBe(2);
    expect(q).toContain('["admin_level"~"^(7|8)$"]');
    expect(q).toContain("is_in(36.000000,138.500000)");
  });
});

describe("公図の自動取得：Overpass の答えを市町村にする", () => {
  it("relation だけを取り、ref（6 桁＝コード＋検査数字）からコードを出す。area や国・県は無視", () => {
    const json = { elements: [
      { type: "area", id: 1, tags: { admin_level: "2", name: "日本" } },
      { type: "relation", id: 2, tags: { admin_level: "4", name: "長野県", ref: "200000" } },
      { type: "relation", id: 3, tags: { admin_level: "7", name: "小川村", ref: "205885" } },
      { type: "relation", id: 3, tags: { admin_level: "7", name: "小川村", ref: "205885" } },
      { type: "relation", id: 4, tags: { admin_level: "7", name: "長野市", "name:ja": "長野市" } },
    ] };
    expect(parseMunicipalities(json)).toEqual([
      { name: "小川村", code: "20588", level: 7, osmId: 3 },
      { name: "長野市", code: null, level: 7, osmId: 4 },
    ]);
  });
  it("政令市の区（admin_level 8）があれば、市（7）は外す", () => {
    const json = { elements: [
      { type: "relation", id: 1, tags: { admin_level: "7", name: "札幌市", ref: "011002" } },
      { type: "relation", id: 2, tags: { admin_level: "8", name: "札幌市中央区", ref: "011011" } },
      { type: "relation", id: 3, tags: { admin_level: "7", name: "小樽市", ref: "012033" } },
    ] };
    expect(parseMunicipalities(json).map((m) => `${m.name}:${m.code}`)).toEqual(["札幌市中央区:01101", "小樽市:01203"]);
  });
});

describe("公図の自動取得：CKAN の結果から選ぶ", () => {
  const pkg = (name: string, title: string, tags: string[], zips: [string, number][]) => ({
    name, title, tags: tags.map((t) => ({ name: t })),
    resources: [{ name: "利用規約", url: "https://example/license.pdf", format: "PDF" }, ...zips.map(([z, size]) => ({ name: z, url: `https://example/${z}`, size, format: "ZIP" }))],
  });
  const results = [
    pkg("houmusyouchizu-2025-1-1039", "上水内郡小川村（長野地方法務局）登記所備付地図データ", ["上水内郡小川村", "長野県"], [["20588-1000-2024.zip", 10], ["20588-1000-2025.zip", 11]]),
    pkg("houmusyouchizu-2026-1-995", "上水内郡小川村（長野地方法務局）登記所備付地図データ", ["上水内郡小川村", "長野県"], [["20588-1000-2025.zip", 11], ["20588-1000-2026.zip", 12]]),
    pkg("houmusyouchizu-2026-1-590", "比企郡小川町（さいたま地方法務局東松山支局）登記所備付地図データ", ["比企郡小川町", "埼玉県"], [["11343-0304-2026.zip", 20]]),
  ];
  it("コードが分かっていれば、その zip のいちばん新しい年版", () => {
    const d = pickDataset(results, "小川村", "20588")!;
    expect(d.zipName).toBe("20588-1000-2026.zip");
    expect(d.year).toBe("2026");
    expect(d.size).toBe(12);
    expect(d.datasetUrl).toBe("https://www.geospatial.jp/ckan/dataset/houmusyouchizu-2026-1-995");
    expect(d.licenseUrl).toBe("https://example/license.pdf");
    expect(pickDataset(results, "小川村", "99999")).toBeNull();
  });
  it("コードが分からなければタグの名前で選ぶ。別の市町村にまたがれば null（取り違えない）", () => {
    expect(pickDataset(results, "小川村", null)!.zipName).toBe("20588-1000-2026.zip");
    expect(pickDataset(results, "小川町", null)!.code).toBe("11343");
    const both = [...results, pkg("x", "別の小川村", ["小川村", "山形県"], [["06999-0000-2026.zip", 1]])];
    expect(pickDataset(both, "小川村", null)).toBeNull();
  });
});

describe("Overpass の入口の切り替え", () => {
  it("本家が 502 なら写しに回り、両方だめなら最後の理由を投げる", async () => {
    const { overpass, OVERPASS_URLS } = await import("./mojfetch");
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return url === OVERPASS_URLS[0] ? new Response("busy", { status: 502 }) : new Response(JSON.stringify({ elements: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await overpass("q", fake)).toEqual({ elements: [] });
    expect(calls).toEqual(OVERPASS_URLS.slice(0, 2)); // 2 つ目で答えたので 3 つ目は呼ばない
    const dead = (async () => new Response("x", { status: 504 })) as unknown as typeof fetch;
    await expect(overpass("q", dead)).rejects.toThrow(/HTTP 504/);
    // 答えないまま → 時間切れで次へ。全部だめなら「時間切れ」と言う
    const hang = ((_: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(overpass("q", hang, 20)).rejects.toThrow(/時間切れ/);
  });
});
