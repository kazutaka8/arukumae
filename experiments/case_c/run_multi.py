"""案C の試し（撮影日の違う写真）：2022年（国土地理院）と 2023年（長野県）の写真を使う。

2通りを比べる。
  single：2023年の写真だけで判定させる（2022年の判定は run.py の結果）。あとで年どうしを突き合わせる
  multi ：2枚を一緒に見せ、「今（新しいほう）の状態」と「前の年からの変化」を判定させる

使い方:
  .venv/bin/python experiments/case_c/run_multi.py single            # Sonnet で 2023年を3回
  .venv/bin/python experiments/case_c/run_multi.py multi             # 3モデル × 2回
県の写真から作った画像は tiles/nagano/ にあり、リポジトリには入れない（結果の JSON だけ残す）。
"""

from __future__ import annotations

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import anthropic

from run import KINDS, MODELS, OTHERS, OUT, PRICE, SYSTEM, api_key, b64, schema

NAGANO = OUT.parent / "tiles" / "nagano"

SYSTEM_MULTI = """あなたは、道路沿いの土地の下調べを手伝います。目的は、大型車両の通行に向けて木を切ることになりそうな所を、現地を歩く前に洗い出すことです。最後に決めるのは人で、あなたの判定は現地で確かめる前の候補として使われます。

同じ範囲を、撮影日の違う2枚の航空写真で渡します（どちらも真上から。表示の縮尺はほぼ同じで、上が北）。
- 写真A：2022年度の撮影（国土地理院）
- 写真B：2023年の撮影（長野県）。こちらが新しい
それぞれ札なしの写真と、道路沿いの「区切り」の枠と番号を描いた写真を渡します。区切りは道路の端から外側へ幅10mほど、道に沿って10mずつ。黄色の枠が進行方向の左（L）、水色の枠が右（R）。2枚の写真で、同じ番号は同じ場所です。

区切りごとに答えること：
- tree_now：新しい写真Bでの、区切りの面積のうち木の樹冠に覆われている割合（0・25・50・75・100）
- tree_old：古い写真Aでの同じ割合
- kind：樹冠の種類（針葉樹・広葉樹・混じる・分からない。木がなければ「なし」）。2枚で季節や影が違えば、見分けやすいほうを使う
- other：新しい写真Bで、木のほかに区切りに写っているもの（道路・草地・畑・建物・設備・水・裸地。なければ空）
- change：2枚の間の変化（変化なし・木が減った・木が増えた・造成や建物の変化・分からない）
- conf：今の状態（tree_now）についての確信（高・中・低）。2枚で影や見え方が違って一方でしか見えない所は、見えるほうを使って確信を決める。変化があった所は、どちらが今の状態かを写真Bで確かめたうえで、確信を下げる
- why：判定の理由を、日本語で短く。2枚を見比べて分かったことがあれば書く

木の高さは写真からは分からないので、考えに入れないでください。迷ったら、木がある側に倒し、確信を下げてください（見落としより、現地で確かめる所が増えるほうがよい）。
指定した番号には、すべて1回ずつ答えてください。"""

CHANGES = ["変化なし", "木が減った", "木が増えた", "造成や建物の変化", "分からない"]


def schema_multi(ids):
    s = schema(ids)
    item = s["properties"]["segments"]["items"]
    props = item["properties"]
    props.pop("tree")
    item["properties"] = {
        "id": props["id"],
        "tree_now": {"type": "integer", "enum": [0, 25, 50, 75, 100]},
        "tree_old": {"type": "integer", "enum": [0, 25, 50, 75, 100]},
        "kind": props["kind"],
        "other": props["other"],
        "change": {"type": "string", "enum": CHANGES},
        "conf": props["conf"],
        "why": props["why"],
    }
    item["required"] = list(item["properties"])
    return s


def img(path):
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64(path)}}


def call(client, model, system, content, sch):
    with client.beta.messages.stream(
        model=model,
        max_tokens=32000,
        system=system,
        messages=[{"role": "user", "content": content}],
        output_config={"effort": "medium", "format": {"type": "json_schema", "schema": sch}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    ) as stream:
        return stream.get_final_message()


def judge(client, mode, window, model_key, run):
    model = MODELS[model_key]
    ids = [s["id"] for s in json.loads((OUT / f"{window}_segments.json").read_text(encoding="utf-8"))]
    if mode == "single":
        content = [
            {"type": "text", "text": "1枚目（札なし）"}, img(NAGANO / f"{window}2023_plain.jpg"),
            {"type": "text", "text": "2枚目（区切りの枠と番号）"}, img(NAGANO / f"{window}2023_labeled.jpg"),
            {"type": "text", "text": "判定する区切り：" + "、".join(ids)},
        ]
        system, sch = SYSTEM, schema(ids)
    else:
        content = [
            {"type": "text", "text": "写真A（2022年度・札なし）"}, img(OUT / f"{window}_plain.jpg"),
            {"type": "text", "text": "写真A（2022年度・区切り）"}, img(OUT / f"{window}_labeled.jpg"),
            {"type": "text", "text": "写真B（2023年・札なし）"}, img(NAGANO / f"{window}2023_plain.jpg"),
            {"type": "text", "text": "写真B（2023年・区切り）"}, img(NAGANO / f"{window}2023_labeled.jpg"),
            {"type": "text", "text": "判定する区切り：" + "、".join(ids)},
        ]
        system, sch = SYSTEM_MULTI, schema_multi(ids)
    t0 = time.time()
    msg = call(client, model, system, content, sch)
    sec = time.time() - t0
    pin, pout = PRICE[model]
    rec = {
        "mode": mode, "window": window, "model": model, "run": run, "seconds": round(sec, 1),
        "stop_reason": msg.stop_reason,
        "input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens,
        "usd": round((msg.usage.input_tokens * pin + msg.usage.output_tokens * pout) / 1e6, 4),
        "segments": [] if msg.stop_reason == "refusal" else json.loads(next(b.text for b in msg.content if b.type == "text"))["segments"],
    }
    d = OUT / f"results_{mode}"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{window}_{model_key}_{run}.json").write_text(json.dumps(rec, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{mode} {window} {model_key} #{run}: {sec:.0f}s 入力 {rec['input_tokens']} 出力 {rec['output_tokens']} ${rec['usd']} 区切り {len(rec['segments'])}/{len(ids)} {msg.stop_reason}", flush=True)


def main():
    mode = sys.argv[1]
    runs = int(os.environ.get("RUNS", "3" if mode == "single" else "2"))
    models = ["sonnet"] if mode == "single" else list(MODELS)
    client = anthropic.Anthropic(api_key=api_key())
    jobs = [(mode, w, m, r) for w in ("A", "B") for m in models for r in range(1, runs + 1)]
    with ThreadPoolExecutor(max_workers=6) as ex:
        for f in [ex.submit(judge, client, *j) for j in jobs]:
            try:
                f.result()
            except anthropic.APIStatusError as e:
                print("API エラー:", e.status_code, e.message, flush=True)


if __name__ == "__main__":
    main()
