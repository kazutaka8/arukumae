/**
 * 案件をこの端末に残す（spec §17.1）。案件は 1 つの保存単位で、丸ごと書いてから古いものが消える。
 * 途中で失敗したら古い案件がそのまま残る（新旧が混ざらない。Codex の指摘 2026-11-03）。
 *
 * 置き場は IndexedDB（1 つの記録に案件を丸ごと）。localStorage は 5MB ほどで、公図の筆が大きい案件は入りきらない。
 * 2026-11-03 までは localStorage に判定・距離標・軌跡・公図・記録・案件名を別々の鍵で置いていた（arukumae.*.ogawa）。
 * その形が残っていれば、最初に読むときに 1 つの案件にまとめ、古い鍵を消す（loadLegacy・clearLegacy）。
 * IndexedDB が使えない環境（古いプライベートブラウズなど）では localStorage に JSON で置く（入らなければ残せない旨を画面に出す）。
 */
const DB_NAME = "arukumae";
const STORE = "project";
const KEY = "current";
const FALLBACK_KEY = "arukumae.project";

function hasIdb(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB を開けませんでした"));
    req.onblocked = () => reject(new Error("IndexedDB が別のタブに使われています"));
  });
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB の操作に失敗しました"));
  });
}

/** 残してある案件（形は検めない。読んだあと parseProject 相当の検めを通す）。IndexedDB に無ければ localStorage も見る（書く側の落とし先） */
export async function loadStored(): Promise<unknown | null> {
  if (hasIdb()) {
    try {
      const db = await openDb();
      try {
        const v = await request(db.transaction(STORE, "readonly").objectStore(STORE).get(KEY));
        if (v) return v;
      } finally {
        db.close();
      }
    } catch (e) {
      console.warn("IndexedDB から読めませんでした。localStorage を見ます", e);
    }
  }
  try {
    const raw = localStorage.getItem(FALLBACK_KEY);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/**
 * 案件を丸ごと残す。1 つのトランザクションの put なので、成功か失敗かのどちらかしかない。
 * 失敗したら投げる（呼ぶ側が「残せない」と画面に出す）
 */
export async function saveStored(project: unknown): Promise<void> {
  if (hasIdb()) {
    try {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(project, KEY);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("IndexedDB に書けませんでした"));
          tx.onabort = () => reject(tx.error ?? new Error("IndexedDB への書き込みが中断されました"));
        });
        return;
      } finally {
        db.close();
      }
    } catch (e) {
      // 開けない・書けない（プライベートブラウズの制限など）なら localStorage に落とす。そこにも入らなければ投げる（呼ぶ側が画面に出す）
      console.warn("IndexedDB に書けなかったので localStorage に残します", e);
    }
  }
  localStorage.setItem(FALLBACK_KEY, JSON.stringify(project));
}

export async function clearStored(): Promise<void> {
  if (hasIdb()) {
    try {
      const db = await openDb();
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(KEY);
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    } catch (e) {
      console.warn(e);
    }
  }
  localStorage.removeItem(FALLBACK_KEY);
}

/** 2026-11-03 までの鍵（見本の案件を別々に残していた形） */
const LEGACY = {
  judgments: "arukumae.judgments.ogawa",
  kps: "arukumae.kps.ogawa",
  track: "arukumae.track.ogawa",
  parcels: "arukumae.parcels.ogawa",
  notes: "arukumae.notes.ogawa",
  name: "arukumae.name.ogawa",
} as const;

export interface LegacyPieces {
  judgments: unknown;
  kps: unknown;
  track: unknown;
  parcels: unknown;
  notes: unknown;
  name: string | null;
}

/** 古い形の保存が 1 つでもあれば、その中身。なければ null */
export function loadLegacy(): LegacyPieces | null {
  const get = (k: string): unknown => {
    try {
      const raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  const any = Object.values(LEGACY).some((k) => localStorage.getItem(k) !== null);
  if (!any) return null;
  return { judgments: get(LEGACY.judgments), kps: get(LEGACY.kps), track: get(LEGACY.track), parcels: get(LEGACY.parcels), notes: get(LEGACY.notes), name: localStorage.getItem(LEGACY.name) };
}

export function clearLegacy() {
  for (const k of Object.values(LEGACY)) localStorage.removeItem(k);
}
