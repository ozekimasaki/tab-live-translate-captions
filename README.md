# tab-live-translate-captions

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-1a73e8)
![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)

`tab-live-translate-captions` は、Deepgram または Grok / xAI の音声認識と Cloud Translation / Gemini を使って、現在の Chrome タブ音声を翻訳字幕としてページ上に重ねて表示する Manifest V3 拡張です。

ページ下部に字幕バーをオーバーレイ表示し、英語・中国語・日本語の音声をリアルタイムで翻訳します。

## 主な機能

- Chrome のアクティブタブ音声を取得して字幕化
- STT プロバイダを `Deepgram` / `Grok (xAI)` から選択可能
- Deepgram `nova-3` によるリアルタイム STT
- Deepgram は interim transcript から仮翻訳を先行表示して初速を詰められる
- Grok / xAI の低遅延 buffered HTTPS 音声認識
- `リアルタイム優先度` で初速と表示安定性のバランスを調整可能
- 翻訳プロバイダを `Cloud Translation` / `Gemini` から選択可能
- Gemini モデルを `gemini-2.5-flash-lite` / `gemini-3.1-flash-lite-preview` から選択可能
- 対応言語ペア
  - 英語 → 日本語
  - 中国語 → 日本語
  - 日本語 → 英語
- 字幕バーのドラッグ移動
- 背景透過率の調整
- 原文プレビューの ON / OFF
- 短い確定字幕を少し保持して読みやすさを改善
- 翻訳停止時の自動再試行と partial / fallback による継続表示
- popup から recent runtime logs を表示 / コピー / クリア可能
- 字幕区切りモードの切り替え
  - `低遅延`
  - `標準`
  - `自然`
- `Grok / xAI` 利用時は入力言語を `英語` / `日本語` に制限

## 動作要件

- Chrome デスクトップ版
- Node.js 18 以上推奨
- 利用する API
  - Deepgram Speech-to-Text または xAI Speech-to-Text
  - Cloud Translation Basic v2 または Gemini API

## セットアップ

```bash
npm install
npm run build
```

ビルド後の拡張本体は `dist/` に出力されます。`dist/` は生成物なので Git では追跡しません。

## Chrome への読み込み

1. `chrome://extensions` を開く
2. `デベロッパーモード` を有効にする
3. `パッケージ化されていない拡張機能を読み込む` を押す
4. このリポジトリの `dist/` を選ぶ

## 使い方

1. 字幕を出したいタブを前面にする
2. 拡張 popup を開く
3. `音声認識プロバイダ` を選ぶ
4. 選んだ STT プロバイダの API Key を入力する
5. `翻訳プロバイダ` を選ぶ
6. 選択した翻訳プロバイダの API Key を入力する
7. Gemini を使う場合は `Gemini モデル` を選ぶ
8. `翻訳方向`、`表示モード`、`字幕の区切り`、`原文プレビュー`、`背景の濃さ` を設定する
9. `字幕を開始` を押す
10. 表示された字幕バーをドラッグして位置を調整する
11. 必要に応じて popup の runtime logs から直近の診断ログを確認し、コピーまたはクリアする

## 設定項目

### API キー

- `xAI API Key`
- `Deepgram API Key`
- `Cloud Translation API Key`
- `Gemini API Key`

API キーは `chrome.storage.local` に保存します。サーバー中継はしていません。

### 音声認識設定

- `音声認識プロバイダ`
  - `Deepgram`
  - `Grok / xAI`
- `翻訳方向`
  - `英語 → 日本語`
  - `中国語 → 日本語`
  - `日本語 → 英語`

`Grok / xAI` 利用時は現在 `英語` / `日本語` 入力のみを許可します。`中国語 → 日本語` を使う場合は `Deepgram` を選んでください。

### 翻訳設定

- `翻訳プロバイダ`
  - `Cloud Translation`
  - `Gemini`
- `Gemini モデル`
  - `gemini-2.5-flash-lite`
  - `gemini-3.1-flash-lite-preview`

### 字幕表示設定

- `表示モード`
  - `翻訳のみ`
  - `原文 + 翻訳`
- `字幕の区切り`
  - `低遅延`
  - `標準`
  - `自然`
- `リアルタイム優先度`
  - `最速優先`
  - `バランス`
  - `安定優先`
- `原文プレビューを表示する`
- `背景の濃さ`
- `runtime log`
  - recent log の確認
  - `コピー`
  - `クリア`

### ランタイムログ

- popup から recent runtime logs を確認できます
- runtime logs は popup からコピーできます
- runtime logs は popup からクリアできます
- ここで見られるのは上限付きで保持される直近の診断ログであり、完全な telemetry / 永続監査ログではありません
- API キーなどの秘密情報はログに含めない前提です

## 対応ページと制約

- 通常の `http/https` ページでの利用を想定しています
- `chrome://*`、Chrome Web Store、その他 content script を注入できないページでは開始できません
- セッションは常に 1 つだけです。別タブで開始した場合は前のセッションを停止します
- 表示設定（表示モード、字幕の区切り、原文プレビュー、背景の濃さ）は実行中にも反映されます
- `音声認識プロバイダ` / `翻訳プロバイダ` / `Gemini モデル` の切り替えは次回開始時に反映されます
- `翻訳方向` は、実行中セッションで STT プロバイダを切り替えていない場合だけ live 反映されます
- 翻訳は確定した字幕区間を単位に送信します
- 短い確定字幕はすぐに消えず、少し保持してから次の字幕へ切り替えます
- 原文プレビューは表示専用で、翻訳 API 呼び出しには使いません
- タブ音声が出ていない場合は字幕は生成されません
- `Grok / xAI` は extension-only 構成では direct realtime WebSocket を使わず、短い音声区間ごとの HTTPS STT で低遅延化しています
- popup で確認できる runtime logs は件数や期間が上限付きの recent diagnostics であり、全イベントの完全保存は目的としていません

## API ごとの注意

### Deepgram

- 使用モデルは `nova-3`
- タブ音声を 16kHz mono PCM に変換して送信しています
- interim transcript を使った speculative translation で、final transcript 前から仮翻訳を出せます

### Grok / xAI

- MV3 offscreen では 16kHz mono PCM を短い区間ごとにまとめて `https://api.x.ai/v1/stt` へ送信して文字起こしします
- browser WebSocket では xAI STT の要求する `Authorization` header を安全に付けられないため、この拡張の xAI は direct realtime WebSocket を使いません
- 安定性とリアルタイム性の両立が必要なら `Deepgram` が最良です。xAI は extension-only では最短ターンの HTTPS STT として扱います
- xAI は interim STT を持たないため、Deepgram と同じ意味での true realtime ではなく near realtime 最適化です
- xAI 側へ渡す入力言語ヒントは現在 `en` / `ja` のみです
- `中国語 → 日本語` は現在 `Grok / xAI` では使えません。必要な場合は `Deepgram` を選んでください

### Cloud Translation

- `Basic v2` を使用します
- Google Cloud 側で `Cloud Translation API` の有効化と課金設定が必要です
- API key には `Cloud Translation API` の利用制限を付けることを推奨します

### Gemini

- 生成モデルのため、Cloud Translation より遅延や揺れが出ることがあります
- ストリーミング更新の都合で、文の途中で表現が差し替わることがあります
- 応答が止まった区間は 1 回だけ自動再試行し、それでも失敗した場合は部分結果または固定文言で先に進みます

## トラブルシュート

### `開始に失敗しました`

- 対象タブが `chrome://*` などの非対応ページでないか確認してください
- 前回のタブキャプチャが残っている場合は、数秒待ってから再試行してください
- 拡張を再読み込みしてから `停止 -> 開始` を試してください

### `音声を待機しています…` のまま進まない

- 対象タブで実際に音声が再生されているか確認してください
- タブ自体がミュートされていないか確認してください
- 選択中の STT プロバイダの API Key が正しいか確認してください

### `Grok / xAI` を選ぶと `中国語 → 日本語` が選べない

- 現在の xAI STT は `英語` / `日本語` 入力のみを許可しています
- `中国語 → 日本語` を使う場合は `Deepgram` を選んでください

### 翻訳が出ない / 不安定

- Cloud Translation を選んでいる場合
  - `Cloud Translation API` が有効化されているか確認してください
  - API key 制限が厳しすぎないか確認してください
  - 応答停止時は自動で 1 回再試行します。それでも失敗した区間は固定文言で継続表示されます
- Gemini を選んでいる場合
  - モデルと API Key が正しいか確認してください
  - 生成系の都合で返答が揺れることがあります
  - 応答停止時は自動で 1 回再試行します。部分結果があればそれを使って継続表示します
- popup の runtime logs を開くと、直近の診断イベントを確認・コピーできます
- 不要になった runtime logs は popup からクリアできます

### 区切りが不自然

- `字幕の区切り` を `標準` または `自然` に上げてください
- 低遅延モードは速さ優先なので、細かく切れやすいです
- 短い字幕の読みづらさは、現在は自動保持である程度吸収されます

## 開発メモ

- `npm run build` で `src/` と `public/` から `dist/` を生成します
- `dist/` は配布用生成物であり、Git では追跡しません
- 追加の runtime dependency は `@deepgram/sdk` のみです

## ファイル構成

- `src/background.js`
  - セッション開始/停止、offscreen 制御、content script 注入
- `src/offscreen.js`
  - タブ音声取得、AudioWorklet、Deepgram STT、xAI STT、Cloud Translation / Gemini 翻訳
- `src/content.js`
  - ページ上の字幕オーバーレイ描画、ドラッグ移動、状態表示
- `src/popup.js`
  - popup UI、設定保存、runtime log viewer
- `src/ui-copy.js`
  - UI 文言、ラベル、状態表示
- `src/audio-worklet.js`
  - PCM 変換と音量通知
- `public/manifest.json`
  - MV3 manifest、権限、popup、icon 定義
- `build.mjs`
  - ビルドスクリプト
