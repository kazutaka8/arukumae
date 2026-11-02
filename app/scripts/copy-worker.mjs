// MapLibre の Worker を public/vendor/ に写す（dev と build の前に走る）。
// Vite の開発サーバーは node_modules の .mjs にも手を入れる（/@vite/client の読み込みを差し込む）ので、
// Worker として読むと最初に失敗して、地図の表示が 10 秒ほど遅れた。public/ のファイルは手を入れずに配られる。
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs");
const dst = resolve(here, "../public/vendor/maplibre-gl-worker.mjs");
mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
