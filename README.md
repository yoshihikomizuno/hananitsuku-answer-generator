# 鼻につくアンサージェネレーター

届いた言い訳や鼻につく指摘に、**もっと鼻につく返事**を作る無料Webサービス。
「上手い言い訳ジェネレーター」「鼻につくジェネレーター」で攻撃された側のためのツールです。

「全然大丈夫ですよ。ちなみに、ハトは何分くらいいました？」

## 特徴

- **相手の文章に合わせてAIが書き下ろす** — Cloudflare Workers AI（無料枠）で、貼った文章の中身に触れた返事を生成
- **無料枠が切れても止まらない** — 1日の無料枠を使い切ると、同じ内容の「呪文」（プロンプト）を表示。ChatGPT / Claude / Gemini に貼って続行できる
- **無料・登録不要** — サイトは GitHub Pages、返事の生成は Cloudflare Worker（Free プランの範囲）
- **10種の技法 × 4段階の鼻につき度 × 4種の相手** — 技法を指定して書かせるので、毎回ちゃんと鼻につく

## 構成

```
index.html            LP＋ジェネレーターUI
css/style.css         BEM / モバイルファースト
js/data.js            お相手・鼻につき度・技法の定義（フロントと Worker で共有）
js/prompt.js          プロンプト組み立て（フロントと Worker で共有）
js/config.js          Worker の接続先
js/app.js             画面制御（失敗時は呪文モードへ）
worker/wrangler.jsonc Worker 設定（AI binding・Durable Object・上限値）
worker/src/           Worker 本体（handler / ai / quota / index）
test/                 node --test
tools/                OGP 画像の版下と生成スクリプト
docs/DESIGN.md        設計書（無料枠の設計・モデル候補・API）
```

## 開発

```powershell
npm install
npm test                       # ユニットテスト（Node 22+）
npm run check                  # wrangler の dry-run（設定検証・ログイン不要）
npm run dev                    # Worker をダミーAIで起動（http://localhost:8787）
python -m http.server 8788     # 静的サイト（別ターミナル）
```

ブラウザで `http://localhost:8788/?api=http://localhost:8787` を開くと、ローカルの Worker を使って動作確認できます
（`?api=` は localhost / 127.0.0.1 のときだけ効きます）。

- ローカル起動は `worker/wrangler.local.jsonc`（AI バインディング無し・ダミーAI固定）を使います。本番の `worker/wrangler.jsonc` は AI バインディングがあるため `wrangler login` なしでは起動できません
- `npm run dev:quota` … 1日上限を3回にして起動（呪文モードへの切り替えを確認する用）
- `npx wrangler dev -c worker/wrangler.local.jsonc --var MOCK_AI:fail`（`quota` / `rate` も可）… AI側の失敗を疑似再現

## 公開

- **サイト**: `main` に push すると GitHub Pages が自動反映
- **Worker**: 初回のみ `npx wrangler login`（ブラウザで Cloudflare にログイン）。以後は `npm run deploy`
- 上限値・モデルの差し替えは `worker/wrangler.jsonc` の `vars`（`DAILY_LIMIT` / `PER_IP_MINUTE` / `PER_IP_DAY` / `AI_MODELS` / `ALLOWED_ORIGINS`）

詳細は `docs/DESIGN.md`。人向けの公開手順は Drive 側 `000_マザリアル\hananitsuku-answer-generator\公開手順.md`。

## SNSサムネイル（OGP画像）

`images/ogp.png` は `tools/ogp-source.html` から生成します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\build-ogp.ps1"
```

## 免責

本サービスが生成した文章の使用により生じたいかなるトラブル・損害についても、制作者は一切の責任を負いません。送る前に深呼吸を。相手にも、明日があります。
