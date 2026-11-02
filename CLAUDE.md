# アルクマエ（arukumae）

現地を歩く前に、かかる筆と木を洗い出す道具。Built with Claude: Japan 2026 に出す。提出の締切は 2026-11-08（日）20:00。

## 最初に読む

- 仕様：[docs/spec.md](docs/spec.md)（機能・受入の条件・Claude の使い方・計画）
- 入力データの出どころ：[data/README.md](data/README.md)
- 背景の数字・デモ動画：[docs/background.md](docs/background.md)・[docs/demo.md](docs/demo.md)
- 試し：[experiments/case_c/](experiments/case_c/)（案C を API で試した結果）

## 作り

- 道具の本体は TypeScript ＋ Vite ＋ MapLibre GL JS（spec §12）。サーバーは持たず、GitHub Pages に置く
- 前処理と試しは Python（`tools/`・`experiments/`）。環境は `.venv/`
- 試しで API を呼ぶときの鍵は、キーチェーンの `arukumae-anthropic-api-key` から読む。鍵をファイル・環境変数・ログに出さない

## 守ること

- **新規制作のみ。** 既存のコードを持ち込まない。期間前に書いた構想のメモはリポジトリの外にあり、ここへ写さない（公式 FAQ の Q4）。要る中身は、期間中に新しく書く
- **公開リポジトリになる。** API キー・`.env`・本名・実在の地権者の情報を入れない。外から持ち込んだデータは `data/README.md` に出典と時期を書く
- **Claude に送るのは公開データの画像だけ**（航空写真の切り抜き、公図の画像）。軌跡図の座標・地名・案件名は送らない（spec §8.7）
- かかる筆を拾うのは計算で決める。AI の判断を挟まない（spec §8.1）
- 法令にふれる表現は断定しない。届出などの要否は「目安。所管に確かめる」と書く
- 壊れたら困る計算（座標の換算、筆の抽出、区切り、面積、キロポスト）は回帰テストで固定する（spec §10）
- 大きな元データ（公図の zip など）は `data/raw/` に置く。リポジトリには入れない
