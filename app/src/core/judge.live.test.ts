/**
 * Claude を実際に1回呼ぶ試し。費用がかかる（Sonnet で約 $0.03）ので、ARUKUMAE_LIVE=1 のときだけ走る。
 *   ARUKUMAE_LIVE=1 npx vitest run src/core/judge.live.test.ts
 * 鍵は macOS のキーチェーン（arukumae-anthropic-api-key）から読む。ファイル・環境変数・ログには出さない（CLAUDE.md）。
 * 画像は試し（experiments/case_c/out/A_*.jpg）のものを使うので、ブラウザがなくても呼び出しの形だけ確かめられる。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { judgeWindow, makeClient } from "./judge";

const live = process.env.ARUKUMAE_LIVE === "1";

describe.skipIf(!live)("judgeWindow（実際に呼ぶ）", () => {
  it("Sonnet が 40 区切り全部に決まった形で答える", async () => {
    const key = execFileSync("security", ["find-generic-password", "-s", "arukumae-anthropic-api-key", "-w"], { encoding: "utf8" }).trim();
    const out = new URL("../../../experiments/case_c/out/", import.meta.url);
    const ids = (JSON.parse(readFileSync(new URL("A_segments.json", out), "utf8")) as { id: string }[]).map((s) => s.id);
    const images = {
      ids,
      plain: readFileSync(new URL("A_plain.jpg", out)).toString("base64"),
      labeled: readFileSync(new URL("A_labeled.jpg", out)).toString("base64"),
      width: 0,
      height: 0,
    };
    const r = await judgeWindow(makeClient(key), "claude-sonnet-5-5", images);
    console.info(`時間 ${r.seconds.toFixed(1)}s 入力 ${r.inputTokens} 出力 ${r.outputTokens} 費用 $${r.usd.toFixed(4)} 区切り ${r.judgments.length}`);
    expect(r.refused).toBe(false);
    expect(r.judgments.map((j) => j.segmentId).sort()).toEqual([...ids].sort());
    for (const j of r.judgments) {
      expect([0, 25, 50, 75, 100]).toContain(j.tree);
      expect(["高", "中", "低"]).toContain(j.conf);
      expect(j.by).toBe("Claude");
    }
  }, 120_000);
});
