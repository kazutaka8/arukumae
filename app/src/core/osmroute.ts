/**
 * OpenStreetMap の道路をたどって中心線を作る（spec §17.2 の (b)）。
 * 軌跡図が届く前に、車両の寸法から架空の軌跡図で下調べするための中心線。
 * 地図で起点と終点を押す → 周りの道路（highway）を Overpass API で取る → つながりを graph にして最短路（ダイクストラ） → 折れ線。
 * 道路名は通った way の name・ref から。出典 © OpenStreetMap contributors（ODbL）は地図の右下と書き出しに出している。
 * ここは計算と問い合わせだけ。画面は main.ts
 */
import { distM } from "./centerline";
import type { LonLat } from "./proj";
import { overpass } from "./mojfetch";

/** 車両が通る道路。歩道・小道・階段・自転車道は除く。track（林道・作業道）は風車の輸送路になることがあるので入れる */
const HIGHWAYS = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|road|track";

export interface OsmWay {
  id: number;
  tags: Record<string, string>;
  nodes: number[];
  geometry: { lat: number; lon: number }[];
}

export function roadsQuery(bbox: [number, number, number, number]): string {
  const [w, s, e, n] = bbox;
  return `[out:json][timeout:60];way["highway"~"^(${HIGHWAYS})(_link)?$"](${s.toFixed(6)},${w.toFixed(6)},${n.toFixed(6)},${e.toFixed(6)});out geom;`;
}

export async function fetchRoads(bbox: [number, number, number, number], fetchFn: typeof fetch = fetch): Promise<OsmWay[]> {
  const json = (await overpass(roadsQuery(bbox), fetchFn)) as { elements?: { type: string; id: number; tags?: Record<string, string>; nodes?: number[]; geometry?: { lat: number; lon: number }[] }[] };
  return (json.elements ?? [])
    .filter((e) => e.type === "way" && e.nodes && e.geometry && e.nodes.length === e.geometry.length && e.nodes.length >= 2)
    .map((e) => ({ id: e.id, tags: e.tags ?? {}, nodes: e.nodes!, geometry: e.geometry! }));
}

export interface Edge {
  to: number;
  w: number;
  way: number;
}

export interface RoadGraph {
  nodes: Map<number, LonLat>;
  adj: Map<number, Edge[]>;
  ways: Map<number, OsmWay>;
}

/** way の並びから、節点（OSM のノード id）と辺（隣り合うノードの間。長さが重み）の graph を作る。向きは見ない（一方通行は輸送の計画の外） */
export function buildGraph(ways: OsmWay[]): RoadGraph {
  const g: RoadGraph = { nodes: new Map(), adj: new Map(), ways: new Map() };
  const link = (a: number, b: number, w: number, way: number) => {
    (g.adj.get(a) ?? g.adj.set(a, []).get(a)!).push({ to: b, w, way });
    (g.adj.get(b) ?? g.adj.set(b, []).get(b)!).push({ to: a, w, way });
  };
  for (const way of ways) {
    g.ways.set(way.id, way);
    for (let i = 0; i < way.nodes.length; i++) g.nodes.set(way.nodes[i], [way.geometry[i].lon, way.geometry[i].lat]);
    for (let i = 1; i < way.nodes.length; i++) {
      const a = way.nodes[i - 1];
      const b = way.nodes[i];
      link(a, b, distM(g.nodes.get(a)!, g.nodes.get(b)!), way.id);
    }
  }
  return g;
}

let virtualId = -1;

/**
 * 押した点を道路の上に寄せる。いちばん近い辺に足を下ろし、そこに仮の節点を足して辺の両端とつなぐ
 * （いちばん近い既存の節点に寄せるだけだと、直線の道では節点が数百 m 離れていることがある）。
 * maxDistM より遠ければ null（道路がない所を押した）
 */
export function snapToRoad(g: RoadGraph, p: LonLat, maxDistM = 100): { node: number; dist: number } | null {
  let best: { a: number; b: number; q: LonLat; dist: number; way: number } | null = null;
  const seen = new Set<string>();
  for (const [a, edges] of g.adj) {
    const pa = g.nodes.get(a)!;
    for (const e of edges) {
      const key = a < e.to ? `${a}-${e.to}` : `${e.to}-${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pb = g.nodes.get(e.to)!;
      const q = footOn(pa, pb, p);
      const d = distM(p, q);
      if (!best || d < best.dist) best = { a, b: e.to, q, dist: d, way: e.way };
    }
  }
  if (!best || best.dist > maxDistM) return null;
  const id = virtualId--;
  g.nodes.set(id, best.q);
  g.adj.set(id, []);
  const link = (x: number, y: number) => {
    const w = distM(g.nodes.get(x)!, g.nodes.get(y)!);
    g.adj.get(x)!.push({ to: y, w, way: best!.way });
    g.adj.get(y)!.push({ to: x, w, way: best!.way });
  };
  link(id, best.a);
  link(id, best.b);
  return { node: id, dist: best.dist };
}

/** 線分 ab に p から下ろした足（線分の外なら近い端） */
function footOn(a: LonLat, b: LonLat, p: LonLat): LonLat {
  const cos = Math.cos((a[1] * Math.PI) / 180);
  const ax = a[0] * cos, ay = a[1], bx = b[0] * cos, by = b[1], px = p[0] * cos, py = p[1];
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
  return [(ax + dx * t) / cos, ay + dy * t];
}

export interface RoutePath {
  coords: LonLat[];
  wayIds: number[];
  lengthM: number;
}

/** ダイクストラ。節点は数千なので、素朴な配列の優先度つき待ち行列で足りる */
export function shortestPath(g: RoadGraph, from: number, to: number): RoutePath | null {
  const dist = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, { node: number; way: number }>();
  const done = new Set<number>();
  const heap: { node: number; d: number }[] = [{ node: from, d: 0 }];
  while (heap.length) {
    let bi = 0;
    for (let i = 1; i < heap.length; i++) if (heap[i].d < heap[bi].d) bi = i;
    const { node, d } = heap.splice(bi, 1)[0];
    if (done.has(node)) continue;
    done.add(node);
    if (node === to) break;
    for (const e of g.adj.get(node) ?? []) {
      const nd = d + e.w;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { node, way: e.way });
        heap.push({ node: e.to, d: nd });
      }
    }
  }
  if (!done.has(to)) return null;
  const coords: LonLat[] = [];
  const wayIds: number[] = [];
  let cur = to;
  for (;;) {
    coords.push(g.nodes.get(cur)!);
    const p = prev.get(cur);
    if (!p) break;
    if (wayIds[wayIds.length - 1] !== p.way) wayIds.push(p.way);
    cur = p.node;
  }
  coords.reverse();
  wayIds.reverse();
  return { coords, wayIds, lengthM: dist.get(to)! };
}

/** 通った way の名前。いちばん長く通った name（なければ ref）。「県道401号 小川長野線」のように ref と name を並べる */
export function roadNameOf(g: RoadGraph, wayIds: number[]): string {
  const score = new Map<string, number>();
  for (const id of wayIds) {
    const w = g.ways.get(id);
    if (!w) continue;
    const name = w.tags.name ?? "";
    const ref = w.tags.ref ?? "";
    const key = [ref ? `${/^\d+$/.test(ref) ? `${ref}号` : ref}` : "", name].filter(Boolean).join(" ");
    if (!key) continue;
    let len = 0;
    for (let i = 1; i < w.geometry.length; i++) len += distM([w.geometry[i - 1].lon, w.geometry[i - 1].lat], [w.geometry[i].lon, w.geometry[i].lat]);
    score.set(key, (score.get(key) ?? 0) + len);
  }
  let best = "";
  let bestLen = 0;
  for (const [k, v] of score) if (v > bestLen) (best = k), (bestLen = v);
  return best;
}

/** 起点と終点から、道路を取る範囲（緯度経度の bbox）。直線距離の 6 割＋500m を四方に足す（つづら折りや迂回で外に出るため） */
export function routeBbox(a: LonLat, b: LonLat): [number, number, number, number] {
  const d = distM(a, b);
  const pad = d * 0.6 + 500;
  const cos = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dLat = pad / 111_195;
  const dLon = pad / (111_195 * cos);
  return [Math.min(a[0], b[0]) - dLon, Math.min(a[1], b[1]) - dLat, Math.max(a[0], b[0]) + dLon, Math.max(a[1], b[1]) + dLat];
}
