# 案C の試し：区切りごとの木の判定

道具の本体を作る前に、Claude が航空写真の区切りごとに木を判定できるかを試した（2026-11-02）。結果のまとめは [docs/spec.md §15](../../docs/spec.md) と [out/summary.md](out/summary.md)。

## やり直し方

```bash
.venv/bin/python experiments/case_c/segments.py overview          # 区間全体の図
.venv/bin/python experiments/case_c/segments.py crop A 0.10 0.30  # 区切りの画像（札なし・札あり）
.venv/bin/python experiments/case_c/segments.py crop B 0.50 0.70
.venv/bin/python experiments/case_c/run.py                        # 2か所 × 3モデル × 3回（約 $2）
.venv/bin/python experiments/case_c/forest.py A B                 # 区切りごとの森林の区域の割合
.venv/bin/python experiments/case_c/analyze.py                    # まとめ
```

API キーはキーチェーンの `arukumae-anthropic-api-key` から読む。

## ファイル

| ファイル | 中身 |
|---|---|
| `segments.py` | 区間の中心線から区切りを作り、航空写真に枠と番号を描く |
| `run.py` | Claude に判定させる（モデル・回数を変えられる） |
| `forest.py` | 区切りが森林の区域に入っている割合（ラスタタイルの画素で数える簡易版） |
| `analyze.py` | ぶれ・モデルどうしの一致・時間と費用をまとめる |
| `out/*_plain.jpg`・`out/*_labeled.jpg` | Claude に見せた画像 |
| `out/results/` | 1回ごとの判定（JSON） |

## 出典

- 航空写真：国土地理院（[地理院タイル](https://maps.gsi.go.jp/development/ichiran.html) 全国最新写真（シームレス））を切り抜き・拡大し、区切りの枠と番号を描き加えて作成
- 森林の区域：林野庁「森林計画対象森林レイヤ」（G空間情報センター）を加工して作成
- 区間の中心線：© OpenStreetMap contributors
- 区切りの幅（道路の端から 10m）は試しの仮の値。軌跡図は使っていない
