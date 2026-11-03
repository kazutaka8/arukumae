import { describe, expect, it } from "vitest";
import { buildGraph, roadNameOf, roadsQuery, routeBbox, shortestPath, snapToRoad, type OsmWay } from "./osmroute";

/** 小川村のあたりの小さな道路網。A—B—C が県道、B—D が脇道、C—D が遠回り */
const g = (lon: number, lat: number) => ({ lon, lat });
const WAYS: OsmWay[] = [
  { id: 1, tags: { highway: "secondary", ref: "401", name: "小川長野線" }, nodes: [1, 2, 3], geometry: [g(137.99, 36.64), g(137.991, 36.64), g(137.992, 36.64)] },
  { id: 2, tags: { highway: "unclassified" }, nodes: [2, 4], geometry: [g(137.991, 36.64), g(137.991, 36.641)] },
  { id: 3, tags: { highway: "track", name: "作業道" }, nodes: [3, 5, 4], geometry: [g(137.992, 36.64), g(137.993, 36.642), g(137.991, 36.641)] },
];

describe("OSM の道路をたどる", () => {
  it("graph は両向きの辺を持ち、重みは m", () => {
    const graph = buildGraph(WAYS);
    expect(graph.nodes.size).toBe(5);
    const e12 = graph.adj.get(1)!.find((e) => e.to === 2)!;
    expect(e12.w).toBeGreaterThan(85);
    expect(e12.w).toBeLessThan(95); // 経度 0.001 度 ≒ 89m
    expect(graph.adj.get(2)!.some((e) => e.to === 1)).toBe(true);
  });
  it("最短路：1 → 4 は 2 を経由（1-2-4）。遠回り（3-5-4）は選ばない", () => {
    const graph = buildGraph(WAYS);
    const p = shortestPath(graph, 1, 4)!;
    expect(p.coords).toEqual([[137.99, 36.64], [137.991, 36.64], [137.991, 36.641]]);
    expect(p.wayIds).toEqual([1, 2]);
    expect(p.lengthM).toBeGreaterThan(190);
    expect(p.lengthM).toBeLessThan(210);
    expect(roadNameOf(graph, p.wayIds)).toBe("401号 小川長野線");
    expect(shortestPath(graph, 1, 999)).toBeNull();
  });
  it("押した点を道路に寄せる：辺の途中に仮の節点を足し、そこから道をたどれる。遠ければ null", () => {
    const graph = buildGraph(WAYS);
    const s = snapToRoad(graph, [137.9905, 36.6401])!; // 1-2 の真ん中の少し北
    expect(s.dist).toBeLessThan(15);
    expect(s.node).toBeLessThan(0);
    const p = shortestPath(graph, s.node, 4)!;
    expect(p.coords.length).toBe(3); // 仮の点 → 2 → 4
    expect(p.lengthM).toBeGreaterThan(140);
    expect(p.lengthM).toBeLessThan(160);
    expect(snapToRoad(graph, [138.1, 36.7])).toBeNull();
  });
  it("起点と終点が同じ辺に落ちても、辺の端まで折り返さず直接つなぐ（辺を分割し、元の辺は外す）", () => {
    const graph = buildGraph(WAYS);
    const s1 = snapToRoad(graph, [137.9902, 36.6401])!; // 1-2 の辺の 2 割
    const s2 = snapToRoad(graph, [137.9908, 36.6401])!; // 同じ辺の 8 割
    const p = shortestPath(graph, s1.node, s2.node)!;
    expect(p.coords.length).toBe(2);
    expect(p.lengthM).toBeGreaterThan(50);
    expect(p.lengthM).toBeLessThan(58); // 経度 0.0006 度 ≒ 54m
    // 元の辺（1-2）は無く、1 → s1 → s2 → 2 とつながる
    expect(graph.adj.get(1)!.some((e) => e.to === 2)).toBe(false);
    expect(shortestPath(graph, 1, 2)!.coords.length).toBe(4);
  });
  it("道路を取る範囲は起点・終点を囲み、問い合わせは highway の種類を絞る", () => {
    const b = routeBbox([137.99, 36.64], [137.992, 36.64]);
    expect(b[0]).toBeLessThan(137.99);
    expect(b[2]).toBeGreaterThan(137.992);
    expect(b[3] - b[1]).toBeGreaterThan(0.009); // 500m 以上
    const q = roadsQuery(b);
    expect(q).toContain('way["highway"~"^(');
    expect(q).toContain("track");
    expect(q).not.toContain("footway");
    expect(q).toContain("out geom");
  });
});
