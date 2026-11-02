"""案C の試し：区切りの判定を Claude に頼み、モデルごとの当たり方とぶれを比べる。

使い方:
  .venv/bin/python experiments/case_c/run.py            # 全部（2か所 × 3モデル × 3回）
  .venv/bin/python experiments/case_c/run.py A sonnet   # 絞って試す

API キーはキーチェーン（arukumae-anthropic-api-key）から読む。
ファイルや環境変数に置くと、うっかりリポジトリやログに残るため。
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
RES = OUT / "results"

MODELS = {
    "sonnet": "claude-sonnet-5-5",
    "opus": "claude-opus-5-5",
    "fable": "claude-fable-5-1",
}
# 料金（$／100万トークン、入力・出力）。2026-10 時点の表。費用の目安を出すためだけに使う
PRICE = {"claude-sonnet-5-5": (2, 10), "claude-opus-5-5": (4, 20), "claude-fable-5-1": (10, 50)}
RUNS = int(os.environ.get("RUNS", "3"))  # 同じ写真で何回判定させるか。ぶれを見るため

KINDS = ["針葉樹", "広葉樹", "混じる", "分からない", "なし"]
OTHERS = ["道路", "草地", "畑", "建物", "設備", "水", "裸地"]

SYSTEM = """あなたは、道路沿いの土地の下調べを手伝います。目的は、大型車両の通行に向けて木を切ることになりそうな所を、現地を歩く前に洗い出すことです。最後に決めるのは人で、あなたの判定は現地で確かめる前の候補として使われます。

渡すもの：
- 1枚目：航空写真（真上から。約 0.5m／画素の写真を3倍に拡大したもの）
- 2枚目：同じ範囲に、道路沿いの「区切り」の枠と番号を描いたもの。区切りは道路の端から外側へ幅10mほど、道に沿って10mずつ。黄色の枠が進行方向の左（L）、水色の枠が右（R）

地面の様子は1枚目で見て、区切りの位置と番号は2枚目で対応させてください。枠や番号が地面を隠している所は、1枚目で確かめてください。

区切りごとに答えること：
- tree：区切りの面積のうち、木の樹冠に覆われている割合（0・25・50・75・100 のどれか）
- kind：樹冠の種類（針葉樹・広葉樹・混じる・分からない。木がなければ「なし」）
- other：木のほかに区切りに写っているもの（道路・草地・畑・建物・設備・水・裸地。なければ空）
- conf：判定の確信（高・中・低）。写真がぼやけている、影で見えない、枠の位置が読み取りにくい、などのときは「低」
- why：判定の理由を、日本語で短く

木の高さは写真からは分からないので、考えに入れないでください。迷ったら、木がある側に倒し、確信を下げてください（見落としより、現地で確かめる所が増えるほうがよい）。
指定した番号には、すべて1回ずつ答えてください。"""


def api_key() -> str:
    return subprocess.run(
        ["security", "find-generic-password", "-s", "arukumae-anthropic-api-key", "-w"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()


def b64(p: Path) -> str:
    return base64.standard_b64encode(p.read_bytes()).decode()


def schema(ids):
    return {
        "type": "object",
        "properties": {
            "segments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "enum": ids},
                        "tree": {"type": "integer", "enum": [0, 25, 50, 75, 100]},
                        "kind": {"type": "string", "enum": KINDS},
                        "other": {"type": "array", "items": {"type": "string", "enum": OTHERS}},
                        "conf": {"type": "string", "enum": ["高", "中", "低"]},
                        "why": {"type": "string"},
                    },
                    "required": ["id", "tree", "kind", "other", "conf", "why"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["segments"],
        "additionalProperties": False,
    }


def judge(client, window, model_key, run):
    model = MODELS[model_key]
    segs = json.loads((OUT / f"{window}_segments.json").read_text(encoding="utf-8"))
    ids = [s["id"] for s in segs]
    content = [
        {"type": "text", "text": "1枚目（札なし）"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64(OUT / f"{window}_plain.jpg")}},
        {"type": "text", "text": "2枚目（区切りの枠と番号）"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64(OUT / f"{window}_labeled.jpg")}},
        {"type": "text", "text": "判定する区切り：" + "、".join(ids)},
    ]
    t0 = time.time()
    # 拒否されたときに別のモデルで続ける設定（fallbacks）を入れておく。どのモデルが答えたかは usage に残る
    with client.beta.messages.stream(
        model=model,
        max_tokens=32000,
        system=SYSTEM,
        messages=[{"role": "user", "content": content}],
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema(ids)}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    ) as stream:
        msg = stream.get_final_message()
    sec = time.time() - t0
    rec = {
        "window": window, "model": model, "run": run, "seconds": round(sec, 1),
        "stop_reason": msg.stop_reason,
        "input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens,
        "fallback_ran": any(getattr(it, "type", "") == "fallback_message" for it in (getattr(msg.usage, "iterations", None) or [])),
    }
    pin, pout = PRICE[model]
    rec["usd"] = round((rec["input_tokens"] * pin + rec["output_tokens"] * pout) / 1e6, 4)
    if msg.stop_reason == "refusal":
        rec["segments"] = []
    else:
        text = next(b.text for b in msg.content if b.type == "text")
        rec["segments"] = json.loads(text)["segments"]
    RES.mkdir(parents=True, exist_ok=True)
    (RES / f"{window}_{model_key}_{run}.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    got = {s["id"] for s in rec["segments"]}
    print(f"{window} {model_key} #{run}: {sec:.0f}s 入力 {rec['input_tokens']} 出力 {rec['output_tokens']} ${rec['usd']} 区切り {len(got)}/{len(ids)} {msg.stop_reason}", flush=True)
    return rec


def main():
    windows = [a for a in sys.argv[1:] if a in ("A", "B")] or ["A", "B"]
    models = [a for a in sys.argv[1:] if a in MODELS] or list(MODELS)
    client = anthropic.Anthropic(api_key=api_key())
    jobs = [(w, m, r) for w in windows for m in models for r in range(1, RUNS + 1)]
    # API への同時の問い合わせは 6 本まで。手元の負荷はほとんどない
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = [ex.submit(judge, client, *j) for j in jobs]
        for f in futs:
            try:
                f.result()
            except anthropic.APIStatusError as e:
                print("API エラー:", e.status_code, e.message, flush=True)


if __name__ == "__main__":
    main()
