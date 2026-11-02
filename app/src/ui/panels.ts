/**
 * 画面の割り付け（spec §6）。地図が主役で、手順（左）・詳細（右）・一覧（下）は開け閉めできるパネル。
 * ここでは DOM を組むだけにし、中身の書き換えは main.ts から呼ぶ。
 */

export const STEPS = [
  { n: 1, title: "案件", hint: "案件名と、運ぶ向き・区間を決めます。" },
  { n: 2, title: "取り込み", hint: "公図（地図XML）と軌跡図（KML）を地図に落とします。" },
  { n: 3, title: "かかる筆", hint: "軌跡図と伐採範囲に重なる筆を、計算で拾いました。黄色の筆です。" },
  { n: 4, title: "木の判定", hint: "区切りごとに、Claude が航空写真から木の有無を判定します。" },
  { n: 5, title: "確かめて直す", hint: "判定を見て、違う所を直します。確信の低い所から順に見られます。" },
  { n: 6, title: "KP", hint: "読んだ距離標を2本以上置くと、全部の区切りに KP（推定）が付きます。" },
  { n: 7, title: "書き出し", hint: "一覧表（CSV・Excel）と、持って歩く地図（PDF）を書き出します。" },
] as const;

export function buildLayout(root: HTMLElement) {
  root.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" id="toggle-steps" title="手順を開く・閉じる" aria-label="手順">☰</button>
      <div class="brand">アルクマエ</div>
      <div class="project" id="project-name">小川村 県道401号（見本）</div>
      <div class="spacer"></div>
      <div class="save-state" id="save-state">見本のデータ。保存はまだしません</div>
      <button class="btn ghost" id="open-settings">設定</button>
    </header>
    <main class="main">
      <div id="map" class="map"></div>

      <aside class="panel steps" id="steps-panel">
        <div class="panel-head"><span>手順</span><button class="icon-btn" data-close="steps-panel" aria-label="閉じる">×</button></div>
        <ol class="step-list" id="step-list"></ol>
        <div class="step-body" id="step-body"></div>
      </aside>

      <aside class="panel detail collapsed" id="detail-panel">
        <div class="panel-head"><span id="detail-title">詳細</span><button class="icon-btn" data-close="detail-panel" aria-label="閉じる">×</button></div>
        <div class="panel-body" id="detail-body"><p class="muted">地図の筆や区切りを押すと、ここに中身が出ます。</p></div>
      </aside>

      <section class="drawer collapsed" id="list-drawer">
        <div class="drawer-handle" id="list-handle"><span id="list-title">かかる筆の一覧</span><span class="muted" id="list-count"></span><span class="chev">▲</span></div>
        <div class="drawer-body" id="list-body"></div>
      </section>

      <div class="legend" id="legend">
        <div class="legend-head"><span>表示</span><button class="icon-btn" id="toggle-legend" aria-label="凡例を閉じる">–</button></div>
        <div class="legend-body" id="legend-body"></div>
      </div>
    </main>

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
        <p class="muted small">鍵はこの端末から Anthropic に直接送ります。作り手のサーバーは通りません。</p>
        <div class="row end"><button class="btn" value="ok">閉じる</button></div>
      </form>
    </dialog>
  `;

  // パネルの開け閉め。閉じても中身は消えない（spec §6.1）
  root.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((b) =>
    b.addEventListener("click", () => document.getElementById(b.dataset.close!)!.classList.add("collapsed")),
  );
  root.querySelector("#toggle-steps")!.addEventListener("click", () => document.getElementById("steps-panel")!.classList.toggle("collapsed"));
  root.querySelector("#list-handle")!.addEventListener("click", () => document.getElementById("list-drawer")!.classList.toggle("collapsed"));
  root.querySelector("#toggle-legend")!.addEventListener("click", (e) => {
    const legend = document.getElementById("legend")!;
    legend.classList.toggle("collapsed");
    (e.currentTarget as HTMLButtonElement).textContent = legend.classList.contains("collapsed") ? "+" : "–";
  });
  const dlg = root.querySelector<HTMLDialogElement>("#settings-dialog")!;
  root.querySelector("#open-settings")!.addEventListener("click", () => dlg.showModal());
}

export function renderSteps(current: number, onSelect: (n: number) => void) {
  const ol = document.getElementById("step-list")!;
  ol.innerHTML = STEPS.map(
    (s) => `<li class="${s.n === current ? "current" : s.n < current ? "done" : ""}" data-n="${s.n}"><span class="num">${s.n}</span><span>${s.title}</span></li>`,
  ).join("");
  ol.querySelectorAll<HTMLLIElement>("li").forEach((li) => li.addEventListener("click", () => onSelect(Number(li.dataset.n))));
}

export function openDetail(title: string, html: string) {
  document.getElementById("detail-title")!.textContent = title;
  document.getElementById("detail-body")!.innerHTML = html;
  document.getElementById("detail-panel")!.classList.remove("collapsed");
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
