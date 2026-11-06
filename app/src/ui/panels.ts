/**
 * 画面の割り付け（spec §6）。地図が主役で、手順（左）・詳細（右）は開け閉めできるパネル。
 * 左のパネルは「手順の列」と「一覧の列」の2列。一覧の列は手順の右に縦に出し、幅をドラッグで変えられる。
 * 下の引き出しだと、飛んだ先の筆を一覧が隠してしまった（2026-11-02 に触ってもらって分かった）。
 * 一覧の列は「かかる筆」「確かめる所」のタブで切り替える。確かめる所が何か所あって今どこかが分かるように。
 * タブの下の絞り込み（チップと検索欄）はここに置いたまま、中身は main.ts が入れる。検索欄を書き換えると打っている途中で焦点が外れるため。
 * ここでは DOM を組むだけにし、中身の書き換えは main.ts から呼ぶ。
 */

export const STEPS = [
  { n: 1, title: "案件", hint: "名前と中心線（道と向き）。" },
  { n: 2, title: "取り込み", hint: "公図と軌跡図を地図に。" },
  { n: 3, title: "かかる筆", hint: "伐採範囲に重なる筆（計算）。" },
  { n: 4, title: "木の判定", hint: "区切りごとに Claude が判定。" },
  { n: 5, title: "確かめて直す", hint: "確信の低い所から順に見て直す。" },
  { n: 6, title: "KP", hint: "距離標を 2 本置くと KP が付く。" },
  { n: 7, title: "書き出し", hint: "一覧表・現地マップ・持って歩く地図。" },
] as const;

/** 一覧の列を見せる手順。かかる筆を確かめる・直す・書き出すとき */
export const STEPS_WITH_LIST: ReadonlySet<number> = new Set([3, 4, 5, 7]);

export type ListTab = "hits" | "checks";

const LIST_W_KEY = "arukumae.listW";
const STEPS_W_KEY = "arukumae.stepsW";

/** 用語の説明。マウスを載せる（または押す）と出る。文字だらけにせず、意味の分からない言葉を残さないため */
export function help(text: string): string {
  return `<span class="help" tabindex="0" data-tip="${escapeHtml(text)}" aria-label="説明">?</span>`;
}

export function buildLayout(root: HTMLElement) {
  root.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" id="toggle-steps" title="手順を開く・閉じる" aria-label="手順">☰</button>
      <div class="brand"><img class="brand-mark" src="./favicon.svg" alt="" width="20" height="20">アルクマエ</div>
      <div class="project" id="project-name">小川村 県道401号（見本）</div>
      <div class="spacer"></div>
      <div class="save-state" id="save-state">見本のデータ。判定はこの端末に残ります</div>
      <button class="btn ghost" id="open-settings">設定</button>
    </header>
    <main class="main">
      <div id="map" class="map"></div>

      <aside class="panel steps" id="steps-panel">
        <div class="steps-col" id="steps-col">
          <div class="panel-head"><span>手順</span><span class="head-btns"><button class="btn small ghost" id="show-list" title="一覧を出す" hidden>一覧 ▸</button><button class="icon-btn" id="hide-steps" title="手順をたたむ（一覧と地図を残す）" aria-label="手順をたたむ">×</button></span></div>
          <ol class="step-list" id="step-list"></ol>
          <div class="step-body" id="step-body"></div>
          <div class="resizer" id="steps-resizer" title="ドラッグで幅を変える"></div>
        </div>
        <div class="list-col" id="list-section" hidden>
          <div class="tabs" role="tablist">
            <button class="btn small ghost" id="show-steps" title="手順を出す" hidden>◂ 手順</button>
            <button class="tab active" data-tab="hits" role="tab">かかる筆 <span class="count" id="list-count"></span></button>
            <button class="tab" data-tab="checks" role="tab">確かめる所 <span class="count" id="check-count"></span></button>
            <button class="icon-btn" id="hide-list" title="一覧をたたむ（手順と地図を残す）" aria-label="一覧をたたむ">×</button>
          </div>
          <div class="filters" data-tab-body="hits">
            <div class="chips" id="hit-chips"></div>
            <div class="filter-row"><input type="search" id="hit-q" placeholder="地番・所在で探す" autocomplete="off" aria-label="地番・所在で探す"><span class="shown" id="hit-shown"></span></div>
          </div>
          <div class="filters" data-tab-body="checks" hidden>
            <div class="chips" id="check-chips"></div>
            <span class="shown" id="check-shown"></span>
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
    <div class="busy" id="busy" hidden role="status"></div>

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
        <label>別の年の写真も一緒に見せる（地理院の年度別写真）
          <select id="photo-second"><option value="">見せない（全国最新写真だけ）</option></select>
        </label>
        <p class="muted small">2 枚を見比べると見落としが減り、「木が減った」「造成された」などの変化も拾えます（費用は約 2 倍）。その年の写真がない窓は 1 枚で判定します。</p>
        <p class="muted small">鍵はこの端末から Anthropic に直接送ります。作り手のサーバーは通りません。送る画像は公開の航空写真の切り抜きだけで、場所の座標や案件名は送りません。</p>
        <div class="row end"><button class="btn" value="ok">閉じる</button></div>
      </form>
    </dialog>
  `;

  // パネルの開け閉め。閉じても中身は消えない（spec §6.1）
  root.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((b) =>
    b.addEventListener("click", () => document.getElementById(b.dataset.close!)!.classList.add("collapsed")),
  );
  wireColumns(root);
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

/**
 * 左のパネルの 2 列（手順・一覧）は、それぞれ別にたためる。
 * 「手順だけ隠して一覧と地図を見たい」「一覧だけ隠したい」の両方があった（2026-11-03 に触ってもらって分かった）。
 * 両方たたんだらパネルごと閉じる。上の ☰ はパネル全体を開け閉めし、開けるときは両方の列を出す
 */
function wireColumns(root: HTMLElement) {
  const panel = root.querySelector<HTMLElement>("#steps-panel")!;
  const sync = () => {
    const noSteps = panel.classList.contains("no-steps");
    const noList = panel.classList.contains("no-list");
    root.querySelector<HTMLElement>("#show-list")!.hidden = !noList || !STEPS_WITH_LIST.has(currentStep);
    root.querySelector<HTMLElement>("#show-steps")!.hidden = !noSteps;
    if (noSteps && (noList || !STEPS_WITH_LIST.has(currentStep))) {
      panel.classList.add("collapsed");
      panel.classList.remove("no-steps", "no-list");
      sync();
    }
  };
  root.querySelector("#hide-steps")!.addEventListener("click", () => {
    panel.classList.add("no-steps");
    sync();
  });
  root.querySelector("#hide-list")!.addEventListener("click", () => {
    panel.classList.add("no-list");
    sync();
  });
  root.querySelector("#show-steps")!.addEventListener("click", () => {
    panel.classList.remove("no-steps");
    if (narrow()) panel.classList.add("no-list"); // スマホ幅は 1 列ずつ：手順を出すなら一覧をたたむ
    sync();
  });
  root.querySelector("#show-list")!.addEventListener("click", () => {
    panel.classList.remove("no-list");
    sync();
  });
  root.querySelector("#toggle-steps")!.addEventListener("click", () => {
    const open = panel.classList.contains("collapsed");
    panel.classList.toggle("collapsed", !open);
    if (open) panel.classList.remove("no-steps", "no-list");
    sync();
  });
  columnSync = sync;
  // スマホ幅：最初は一覧をたたみ、凡例も閉じておく（地図が見えなくなるため）
  if (narrow()) {
    panel.classList.add("no-list");
    root.querySelector("#legend")!.classList.add("collapsed");
    root.querySelector("#toggle-legend")!.textContent = "+";
  }
}

const narrow = () => window.innerWidth < 600;

let currentStep = 1;
let columnSync: (() => void) | null = null;

/**
 * 列の幅。ドラッグで変え、この端末に覚える。画面の広さと筆の数で、ちょうどよい幅が人によって違うため。
 * 手順の列（--steps-w）と一覧の列（--list-w）に同じ仕組みを使う
 */
function wireResizer(root: HTMLElement) {
  const panel = root.querySelector<HTMLElement>("#steps-panel")!;
  const one = (handleId: string, colId: string, cssVar: string, key: string, min: number, max: number) => {
    const saved = Number(localStorage.getItem(key));
    if (saved >= min && saved <= max) panel.style.setProperty(cssVar, `${saved}px`);
    const handle = root.querySelector<HTMLElement>(handleId)!;
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const col = root.querySelector<HTMLElement>(colId)!;
      const startX = e.clientX;
      const startW = col.getBoundingClientRect().width;
      panel.classList.add("resizing");
      // 動きと離す操作は window で拾う。速く動かして指がつまみから外れても追いかけるため
      const move = (ev: PointerEvent) => {
        const w = Math.min(max, Math.max(min, startW + ev.clientX - startX));
        panel.style.setProperty(cssVar, `${w}px`);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        panel.classList.remove("resizing");
        localStorage.setItem(key, String(Math.round(col.getBoundingClientRect().width)));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
  };
  one("#list-resizer", "#list-section", "--list-w", LIST_W_KEY, 260, 760);
  one("#steps-resizer", "#steps-col", "--steps-w", STEPS_W_KEY, 220, 520);
}

/**
 * 時間のかかる処理の知らせ（中央上）。描かれてから計算を始めるよう、画面を止める計算の前では呼ぶ側が setTimeout で一拍置く。
 * 経過の秒を出す：何秒も待たされると止まったように見えて不安になる、と言われた（2026-11-04）。
 * 通信（市町村を当てる・公図を探す）のように終わりの分からない待ちにも使う
 */
let busyTimer: ReturnType<typeof setInterval> | null = null;
export function showBusy(text: string) {
  const el = document.getElementById("busy")!;
  const started = Date.now();
  const draw = () => {
    const sec = Math.round((Date.now() - started) / 1000);
    el.innerHTML = `<span class="spin" aria-hidden="true"></span><span>${escapeHtml(text)}</span><span class="sec">${sec >= 2 ? `${sec} 秒` : ""}</span>`;
  };
  if (busyTimer) clearInterval(busyTimer);
  draw();
  busyTimer = setInterval(draw, 1000);
  el.hidden = false;
}

export function hideBusy() {
  if (busyTimer) clearInterval(busyTimer);
  busyTimer = null;
  document.getElementById("busy")!.hidden = true;
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
  currentStep = current;
  columnSync?.();
}

/**
 * 手順のパネルが下の引き出しになっている幅か（style.css の @media (max-width: 820px) と同じ境。iPad の縦向き）。
 * 引き出しは画面の幅いっぱいなので、その幅を左の余白にすると余白が画面より広くなり、MapLibre が移動をやめる
 * （一覧の行を押しても地図が動かなかった。Codex の指摘 2026-11-06。768×1024 で確かめた）。下の余白として扱う
 */
function isDrawer(): boolean {
  return window.matchMedia("(max-width: 820px)").matches;
}

/** 左のパネルが地図を隠している幅（px）。飛ぶ先をパネルの外に寄せるために使う */
export function leftCover(): number {
  const panel = document.getElementById("steps-panel")!;
  return panel.classList.contains("collapsed") || isDrawer() ? 0 : panel.getBoundingClientRect().width + 20;
}

/** 下の引き出しが地図を隠している高さ（px）。引き出しでない幅では 0 */
export function bottomCover(): number {
  const panel = document.getElementById("steps-panel")!;
  return panel.classList.contains("collapsed") || !isDrawer() ? 0 : panel.getBoundingClientRect().height + 20;
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
