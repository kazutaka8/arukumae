# 案C の試し：区切りごとの木の判定

道具の本体を作る前に、Claude が航空写真の区切りごとに木を判定できるかを試した（2026-11-02）。結果のまとめは [docs/spec.md §15](../../docs/spec.md) と [out/summary.md](out/summary.md)。

## やり直し方

```bash
.venv/bin/python experiments/case_c/segments.py overview          # 区間全体の図
.venv/bin/python experiments/case_c/segments.py crop A 100 300  # 区切りの画像（札なし・札あり）
.venv/bin/python experiments/case_c/segments.py crop B 500 700
.venv/bin/python experiments/case_c/run.py                        # 2か所 × 3モデル × 3回（約 $2）
.venv/bin/python experiments/case_c/forest.py A B                 # 区切りごとの森林の区域の割合
```

道具の本体が作る区切り（既定の車両の架空の軌跡図）で見本の判定を取り直す（2026-11-03。道具に入れている見本はこちら）：

```bash
# app/ で既定の車両の区切りを GeoJSON に書き出す（segmentsToGeoJSON。窓 A=100〜300m、B=500〜700m の id）→ out/A_vehicle_segments.geojson
.venv/bin/python experiments/case_c/segments.py crop-from A_vehicle experiments/case_c/out/A_vehicle_segments.geojson
.venv/bin/python experiments/case_c/segments.py crop-from B_vehicle experiments/case_c/out/B_vehicle_segments.geojson
.venv/bin/python -c "import sys; sys.path.insert(0,'experiments/case_c'); import run, anthropic; c=anthropic.Anthropic(api_key=run.api_key()); [run.judge(c, w, 'sonnet', 1) for w in ('A_vehicle','B_vehicle')]"
```

初日の試し（A・B）は幅 13m の固定の帯で判定した。道具の区切りはカーブの外側で幅 45m になり（ブレードの先の振れ）、
13m の帯で「草地が主体 25%」だった L050〜L052 が、道具では森ばかりの区切りになっていた（触ってもらって分かった）。
取り直した結果（`out/results/*_vehicle_sonnet_1.json`）では L050・L051 が 75%、L052 が 100%。Sonnet 1 回、2 窓で $0.06。
.venv/bin/python experiments/case_c/analyze.py                    # まとめ
```

撮影日の違う写真（2022年 国土地理院・2023年 長野県）の試し：

```bash
# 長野県の写真は zip（1.4GB）から区間の図郭 B7-c0 だけを範囲指定で取り、tiles/nagano/ に置く（手順は data/README.md）
.venv/bin/python experiments/case_c/segments.py crop-nagano A2023 100 300 experiments/case_c/tiles/nagano/B7-c0.tif
.venv/bin/python experiments/case_c/segments.py crop-nagano B2023 500 700 experiments/case_c/tiles/nagano/B7-c0.tif
cd experiments/case_c && ../../.venv/bin/python run_multi.py single && ../../.venv/bin/python run_multi.py multi
../../.venv/bin/python analyze_multi.py
```

API キーはキーチェーンの `arukumae-anthropic-api-key` から読む。

## ファイル

| ファイル | 中身 |
|---|---|
| `segments.py` | 区間の中心線から区切りを作り、航空写真に枠と番号を描く |
| `run.py` | Claude に判定させる（モデル・回数を変えられる） |
| `forest.py` | 区切りが森林の区域に入っている割合（ラスタタイルの画素で数える簡易版） |
| `analyze.py` | ぶれ・モデルどうしの一致・時間と費用をまとめる |
| `jgd.py` | 緯度経度 → 平面直角座標系（第VIII系）。長野県の写真に区切りを重ねるため |
| `run_multi.py`・`analyze_multi.py` | 撮影日の違う写真の試し（2023年だけ／2枚を一緒に）とまとめ |
| `out/results_single/`・`out/results_multi/` | その判定（JSON）。長野県の写真から作った画像は入れていない |
| `out/*_plain.jpg`・`out/*_labeled.jpg` | Claude に見せた画像。`*_vehicle_*` は道具の区切りの形で描いたもの |
| `out/*_vehicle_segments.geojson` | 道具の本体が作った区切り（既定の車両）。`crop-from` の入力 |
| `out/results/` | 1回ごとの判定（JSON） |

## 出典

- 航空写真：国土地理院（[地理院タイル](https://maps.gsi.go.jp/development/ichiran.html) 全国最新写真（シームレス））を切り抜き・拡大し、区切りの枠と番号を描き加えて作成
- 森林の区域：林野庁「森林計画対象森林レイヤ」（G空間情報センター）を加工して作成
- 区間の中心線：© OpenStreetMap contributors
- 別の年の写真：長野県林務部による空中写真撮影成果のオルソ画像（令和5年度撮影）（https://www.geospatial.jp/ckan/organization/nagano-rinsei）。CC BY。利用者案内の「使用後は破棄」に合わせ、写真から作った画像はリポジトリに入れていない
- 区切りの幅（道路の端から 10m）は試しの仮の値。軌跡図は使っていない
