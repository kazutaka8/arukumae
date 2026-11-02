/**
 * 法務省の地図データの zip を、展開せずに読む。
 * 配られる zip は「市町村の zip → 地図ごとの zip → XML」の二重の入れ子で、主の地図は展開すると 170MB ほどある。
 * 全部をメモリに置かず、fflate の流し読みで外の zip → 中の zip → XML と順に流し、XML は MojxmlParser に文字列で渡す。
 * 中の zip 1 つ、XML 1 つをそのまま落とされても読めるように、先頭の数バイトで zip か XML かを見分ける。
 */
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { MojxmlParser, type MojMap } from "./mojxml";

export interface MojReaderEvents {
  /** 1 枚の地図を読み終えた */
  onMap(map: MojMap): void;
  /** XML の読み始め（進み具合の表示用） */
  onStart?(fileName: string): void;
  /** zip の中の、地図でないファイル（検索用の CSV など） */
  onSkip?(fileName: string): void;
}

export interface MojReader {
  /** バイト列を順に流し込む。最後は final=true */
  push(chunk: Uint8Array, final: boolean): void;
}

function xmlSink(fileName: string, ev: MojReaderEvents): MojReader {
  const dec = new TextDecoder("utf-8");
  const parser = new MojxmlParser(fileName);
  ev.onStart?.(fileName);
  return {
    push(chunk, final) {
      parser.push(dec.decode(chunk, { stream: !final }));
      if (!final) return;
      const m = parser.end();
      // 地図XML でなければ（KML など）、地図としては数えず「読まなかったファイル」にする
      if (m.recognized) ev.onMap(m);
      else ev.onSkip?.(fileName);
    },
  };
}

function zipSink(ev: MojReaderEvents): MojReader {
  const u = new Unzip();
  u.register(UnzipInflate);
  u.register(UnzipPassThrough);
  u.onfile = (f) => {
    const lower = f.name.toLowerCase();
    let inner: MojReader | null = null;
    if (lower.endsWith(".xml")) inner = xmlSink(f.name, ev);
    else if (lower.endsWith(".zip")) inner = zipSink(ev);
    if (!inner) {
      ev.onSkip?.(f.name);
      return;
    }
    const sink = inner;
    f.ondata = (err, data, final) => {
      if (err) throw err;
      sink.push(data, final);
    };
    f.start();
  };
  return {
    push(chunk, final) {
      u.push(chunk, final);
    },
  };
}

/**
 * zip か XML かを先頭で見分けて読み手を作る。先頭の 4 バイトが揃うまでは溜める。
 * fflate の Unzip は同期なので、push の中で onMap まで呼ばれる
 */
export function createMojReader(fileName: string, ev: MojReaderEvents): MojReader {
  let head: Uint8Array[] = [];
  let headLen = 0;
  let inner: MojReader | null = null;
  return {
    push(chunk, final) {
      if (inner) {
        inner.push(chunk, final);
        return;
      }
      head.push(chunk);
      headLen += chunk.length;
      if (headLen < 4 && !final) return;
      const all = concat(head);
      head = [];
      const isZip = all.length >= 4 && all[0] === 0x50 && all[1] === 0x4b && all[2] === 0x03 && all[3] === 0x04;
      inner = isZip ? zipSink(ev) : xmlSink(fileName, ev);
      inner.push(all, final);
    },
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** バイト列を一度に読む（テスト用） */
export function readMojBytes(fileName: string, bytes: Uint8Array): MojMap[] {
  const maps: MojMap[] = [];
  createMojReader(fileName, { onMap: (m) => maps.push(m) }).push(bytes, true);
  return maps;
}
