/**
 * 画面の割り付け（spec §6）。地図が主役で、手順（左）・詳細（右）は開け閉めできるパネル。
 * 左のパネルは「手順の列」と「一覧の列」の2列。一覧の列は手順の右に縦に出し、幅をドラッグで変えられる。
 * 下の引き出しだと、飛んだ先の筆を一覧が隠してしまった（2026-11-02 に触ってもらって分かった）。
 * 一覧の列は「かかる筆」「確かめる所」のタブで切り替える。確かめる所が何か所あって今どこかが分かるように。
 * ここでは DOM を組むだけにし、中身の書き換えは main.ts から呼ぶ。
 */

export const STEPS = [
  { n: 1, title: "案件", hint: "案件名と、運ぶ向き・区間を決めます。" },
  { n: 2, title: "取り込み", hint: "公図と軌跡図を地図に落とします。軌跡図がなければ、車両の寸法から架空のものを作れます。" },
  { n: 3, title: "かかる筆", hint: "伐採範囲に重なる筆を、計算で拾いました。黄色がかかる部分です。" },
  { n: 4, title: "木の判定", hint: "区切りごとに、Claude が航空写真から木の有無を判定します。" },
  { n: 5, title: "確かめて直す", hint: "判定を見て、違う所を直します。確信の低い所から順に見られます。" },
  { n: 6, title: "KP", hint: "読んだ距離標を2本以上置くと、全部の区切りに KP（推定）が付きます。" },
  { n: 7, title: "書き出し", hint: "一覧表（CSV・Excel）と、持って歩く地図（PDF）を書き出します。" },
] as const;

/** 一覧の列を見せる手順。かかる筆を確かめる・直す・書き出すとき */
export const STEPS_WITH_LIST: ReadonlySet<number> = new Set([3, 4, 5, 7]);

export type ListTab = "hits" | "checks";

const LIST_W_KEY = "arukumae.listW";

/** 用語の説明。マウスを載せる（または押す）と出る。文字だらけにせず、意味の分からない言葉を残さないため */
export function help(text: string): string {
  return `<span class="help" tabindex="0" data-tip="${escapeHtml(text)}" aria-label="説明">?</span>`;
}

export function buildLayout(root: HTMLElement) {
  root.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" id="toggle-steps" title="手順を開く・閉じる" aria-label="手順">☰</button>
      <div class="brand">アルクマエ</div>
      <div class="project" id="project-name">小川村 県道401号（見本）</div>
      <div class="spacer"></div>
      <div class="save-state" id="save-state">見本のデータ。判定はこの端末に残ります</div>
      <button class="btn ghost" id="open-settings">設定</button>
    </header>
    <main class="main">
      <div id="map" class="map"></div>

      <aside class="panel steps" id="steps-panel">
        <div class="steps-col">
          <div class="panel-head"><span>手順</span><button class="icon-btn" data-close="steps-panel" aria-label="閉じる">×</button></div>
          <ol class="step-list" id="step-list"></ol>
          <div class="step-body" id="step-body"></div>
        </div>
        <div class="list-col" id="list-section" hidden>
          <div class="tabs" role="tablist">
            <button class="tab active" data-tab="hits" role="tab">かかる筆 <span class="count" id="list-count"></span></button>
            <button class="tab" data-tab="checks" role="tab">確かめる所 <span class="count" id="check-count"></span></button>
          </div>
          <div class="list-body" id="list-body" data-tab-body="hits"></div>
          <div class="list-body" id="check-body" data-tab-body="checks" hidden></div>
          <div class="resizer" id="list-resizer" title="ドラッグで幅を変える"></div>
        </div>
      </aside>

      <aside class="panel detail collapsed" id="detail-panel">
        <div class="panel-head"><span id="detail-title">詳細</span><button class="icon-btn" data-close="detail-panel" aria-label="閉じる">×</button></div>
        <div class="panel-body" id="detail-body"><p class="muted">地図の筆や区切りを押すと、ここに中身が出ます。</p></div>
      </aside>

      <div class="legend" id="legend">
        <div class="legend-head"><span>表示</span><button class="icon-btn" id="toggle-legend" aria-label="凡例を閉じる">–</button></div>
        <div class="legend-body" id="legend-body"></div>
      </div>
    </main>

    <div class="tip" id="tip" hidden></div>

    <dialog id="settings-dialog" class="dialog">
      <form method="dialog">
        <h2>設定</h2>
        <label>Anthropic の API キー
          <input type="password" id="api-key" placeholder="sk-ant-…" autocomplete="off" />
        </label>
        <label class="row"><input type="checkbox" id="remember-key" /> この端末に記憶する（既定ではこの画面を閉じるまで）</label>
        <label>木を判定するモデル
          <select id="model-main">
            <option value="claude-sonnet-5-5">Claude Sonnet 5.5（既定。速くて安い）</option>
            <option value="claude-opus-5-5">Claude Opus 5.5</option>
          </select>
        </label>
        <label>迷う区切りを見直すモデル
          <select id="model-review">
            <option value="claude-fable-5-1">Claude Fable 5.1（既定）</option>
            <option value="claude-opus-5-5">Claude Opus 5.5</option>
            <option value="">見直さない</option>
          </select>
        </label>
        <p class="muted small">鍵はこの端末から Anthropic に直接送ります。作り手のサーバーは通りません。送る画像は公開の航空写真の切り抜きだけで、場所の座標や案件名は送りません。</p>
        <div class="row end"><button class="btn" value="ok">閉じる</button></div>
      </form>
    </dialog>
  `;

  // パネルの開け閉め。閉じても中身は消えない（spec §6.1）
  root.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((b) =>
    b.addEventListener("click", () => document.getElementById(b.dataset.close!)!.classList.add("collapsed")),
  );
  root.querySelector("#toggle-steps")!.addEventListener("click", () => document.getElementById("steps-panel")!.classList.toggle("collapsed"));
  root.querySelector("#toggle-legend")!.addEventListener("click", (e) => {
    const legend = document.getElementById("legend")!;
    legend.classList.toggle("collapsed");
    (e.currentTarget as HTMLButtonElement).textContent = legend.classList.contains("collapsed") ? "+" : "–";
  });
  root.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => b.addEventListener("click", () => showListTab(b.dataset.tab as ListTab)));
  const dlg = root.querySelector<HTMLDialogElement>("#settings-dialog")!;
  root.querySelector("#open-settings")!.addEventListener("click", () => dlg.showModal());

  wireResizer(root);
  wireHelp(root);
}

/** 一覧の列の幅。ドラッグで変え、この端末に覚える。画面の広さと筆の数で、ちょうどよい幅が人によって違うため */
function wireResizer(root: HTMLElement) {
  const panel = root.querySelector<HTMLElement>("#steps-panel")!;
  const saved = Number(localStorage.getItem(LIST_W_KEY));
  if (saved >= 260) panel.style.setProperty("--list-w", `${saved}px`);
  const handle = root.querySelector<HTMLElement>("#list-resizer")!;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const col = root.querySelector<HTMLElement>("#list-section")!;
    const startX = e.clientX;
    const startW = col.getBoundingClientRect().width;
    panel.classList.add("resizing");
    // 動きと離す操作は window で拾う。速く動かして指がつまみから外れても追いかけるため
    const move = (ev: PointerEvent) => {
      const w = Math.min(760, Math.max(260, startW + ev.clientX - startX));
      panel.style.setProperty("--list-w", `${w}px`);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      panel.classList.remove("resizing");
      localStorage.setItem(LIST_W_KEY, String(Math.round(col.getBoundingClientRect().width)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
}

/** 「?」に載せると説明を出す。パネルは overflow: hidden なので、中に置かず画面に直接置く */
function wireHelp(root: HTMLElement) {
  const tip = root.querySelector<HTMLElement>("#tip")!;
  let current: HTMLElement | null = null;
  const show = (el: HTMLElement) => {
    current = el;
    tip.textContent = el.dataset.tip ?? "";
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = Math.min(280, window.innerWidth - 20);
    tip.style.width = `${w}px`;
    tip.style.left = `${Math.min(r.left, window.innerWidth - w - 10)}px`;
    tip.style.top = `${r.bottom + 6}px`;
  };
  const hide = () => {
    current = null;
    tip.hidden = true;
  };
  root.addEventListener("mouseover", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".help");
    if (el) show(el);
    else if (current) hide();
  });
  root.addEventListener("focusin", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".help");
    if (el) show(el);
  });
  root.addEventListener("focusout", hide);
  // 触る画面では載せられないので、押しても出る。もう一度押すと消える
  root.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(".help");
    if (!el) return;
    if (current === el && !tip.hidden) hide();
    else show(el);
  });
}

export function showListTab(tab: ListTab) {
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll<HTMLElement>("[data-tab-body]").forEach((d) => (d.hidden = d.dataset.tabBody !== tab));
}

export function renderSteps(current: number, onSelect: (n: number) => void) {
  const ol = document.getElementById("step-list")!;
  ol.innerHTML = STEPS.map(
    (s) => `<li class="${s.n === current ? "current" : s.n < current ? "done" : ""}" data-n="${s.n}"><span class="num">${s.n}</span><span>${s.title}</span></li>`,
  ).join("");
  ol.querySelectorAll<HTMLLIElement>("li").forEach((li) => li.addEventListener("click", () => onSelect(Number(li.dataset.n))));
  // 一覧の要る手順では列を出す。要らない手順では地図を広く使う
  document.getElementById("list-section")!.hidden = !STEPS_WITH_LIST.has(current);
}

/** 左のパネルが地図を隠している幅（px）。飛ぶ先をパネルの外に寄せるために使う */
export function leftCover(): number {
  const panel = document.getElementById("steps-panel")!;
  return panel.classList.contains("collapsed") ? 0 : panel.getBoundingClientRect().width + 20;
}

export function rightCover(): number {
  const panel = document.getElementById("detail-panel")!;
  return panel.classList.contains("collapsed") ? 0 : panel.getBoundingClientRect().width + 20;
}

export function openDetail(title: string, html: string) {
  document.getElementById("detail-title")!.textContent = title;
  document.getElementById("detail-body")!.innerHTML = html;
  document.getElementById("detail-panel")!.classList.remove("collapsed");
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
