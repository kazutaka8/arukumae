/**
 * 道路名とキロポスト（F9、spec §8.6）。
 * KP は道路管理者が決めた「その道路の起点からの距離」で、道ばたの距離標に書いてある。位置も値も公開データに無いので、
 * 人が読んだ距離標を 2 本以上置き、その間を中心線に沿った距離で直線補間する。距離標の外側は外挿と明記する。
 * 「起点からの距離（m）」は案件の区間の起点から測ったもので、KP とは別の物差し。
 */

export interface KpMark {
  /** 中心線の上の位置（起点からの距離 m） */
  atM: number;
  /** 距離標の値（km） */
  kp: number;
}

export interface KpEstimate {
  /** 推定した KP（km） */
  kp: number;
  /** 根拠。「距離標 12.0〜12.5 から補間」「距離標 12.0〜12.5 から外挿」 */
  basis: string;
  extrapolated: boolean;
}

/** 起点からの距離 m の地点の KP を推定する。距離標が 2 本未満なら null */
export function estimateKp(marks: KpMark[], m: number): KpEstimate | null {
  if (marks.length < 2) return null;
  const sorted = [...marks].sort((a, b) => a.atM - b.atM);
  // 挟む 2 本を探す。外側なら端の 2 本で外挿する。改築などで距離標と実際の距離がずれていることがあるので、なるべく近い 2 本を使う
  let a = sorted[0];
  let b = sorted[1];
  let extrapolated = true;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].atM <= m && m <= sorted[i + 1].atM) {
      a = sorted[i];
      b = sorted[i + 1];
      extrapolated = false;
      break;
    }
  }
  if (extrapolated && m > sorted[sorted.length - 1].atM) {
    a = sorted[sorted.length - 2];
    b = sorted[sorted.length - 1];
  }
  const span = b.atM - a.atM;
  const kp = span === 0 ? a.kp : a.kp + ((b.kp - a.kp) * (m - a.atM)) / span;
  const lo = Math.min(a.kp, b.kp);
  const hi = Math.max(a.kp, b.kp);
  return {
    kp,
    basis: `距離標 ${fmtKm(lo)}〜${fmtKm(hi)} から${extrapolated ? "外挿" : "補間"}`,
    extrapolated,
  };
}

export function fmtKm(km: number): string {
  return km.toFixed(2);
}

/** 画面と一覧表に出す形。「小川長野線 12.34km 付近（推定）」 */
export function formatKp(roadName: string, est: KpEstimate | null): string {
  if (!est) return "";
  return `${roadName} ${fmtKm(est.kp)}km 付近（推定）`;
}

/**
 * 距離標の値の入力（km）を数にする。読めなければ null。
 * 日本語入力のままの全角（「１２．３」）は半角に直して読む。前は「数字と点以外を消す」だけだったので、全角は全部消えて
 * 空になり、Number("") の 0 がそのまま距離標の値として記録された（補間・一覧表・案件ファイルまで 0 が流れた。Codex の指摘 2026-11-06）。
 * 「12.3km」「KP12.3」のような前後の字は許すが、数が 1 つに決まらない入力（「12,3」「1.2.3」・空）は断る
 */
export function parseKpInput(raw: string): number | null {
  const m = /^[^\d.]*(\d+(?:\.\d+)?)[^\d.]*$/.exec(raw.normalize("NFKC").trim());
  if (!m) return null;
  const kp = Number(m[1]);
  return Number.isFinite(kp) ? kp : null;
}
