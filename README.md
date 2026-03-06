# Deepfram Extension

Deepgram のリアルタイム音声認識と Cloud Translation / Gemini を使って、現在の Chrome タブ音声を翻訳字幕としてページ上に重ねて表示する Manifest V3 拡張です。

ページ下部に字幕バーをオーバーレイ表示し、英語・中国語・日本語の音声をリアルタイムで翻訳します。

## 主な機能

- Chrome のアクティブタブ音声を取得して字幕化
- Deepgram `nova-3` によるリアルタイム STT
- 翻訳プロバイダを `Cloud Translation` / `Gemini` から選択可能
- Gemini モデルを `gemini-2.5-flash-lite` / `gemini-3.1-flash-lite-preview` から選択可能
- 対応言語ペア
  - 英語 → 日本語
  - 中国語 → 日本語
  - 日本語 → 英語
- 字幕バーのドラッグ移動
- 背景透過率の調整
- 原文プレビューの ON / OFF
- 字幕区切りモードの切り替え
  - `低遅延`
  - `標準`
  - `自然`

## 動作要件

- Chrome デスクトップ版
- Node.js 18 以上推奨
- 利用する API
  - Deepgram Speech-to-Text
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
3. `翻訳プロバイダ` を選ぶ
4. `Deepgram API Key` を入力する
5. 選択した翻訳プロバイダの API Key を入力する
6. Gemini を使う場合は `Gemini モデル` を選ぶ
7. `翻訳方向`、`表示モード`、`字幕の区切り`、`原文プレビュー`、`背景の濃さ` を設定する
8. `字幕を開始` を押す
9. 表示された字幕バーをドラッグして位置を調整する

## 設定項目

### API キー

- `Deepgram API Key`
- `Cloud Translation API Key`
- `Gemini API Key`

API キーは `chrome.storage.local` に保存します。サーバー中継はしていません。

### 翻訳設定

- `翻訳プロバイダ`
  - `Cloud Translation`
  - `Gemini`
- `Gemini モデル`
  - `gemini-2.5-flash-lite`
  - `gemini-3.1-flash-lite-preview`
- `翻訳方向`
  - `英語 → 日本語`
  - `中国語 → 日本語`
  - `日本語 → 英語`

### 字幕表示設定

- `表示モード`
  - `翻訳のみ`
  - `原文 + 翻訳`
- `字幕の区切り`
  - `低遅延`
  - `標準`
  - `自然`
- `原文プレビューを表示する`
- `背景の濃さ`

## 対応ページと制約

- 通常の `http/https` ページでの利用を想定しています
- `chrome://*`、Chrome Web Store、その他 content script を注入できないページでは開始できません
- セッションは常に 1 つだけです。別タブで開始した場合は前のセッションを停止します
- 翻訳は確定した字幕区間を単位に送信します
- 原文プレビューは表示専用で、翻訳 API 呼び出しには使いません
- タブ音声が出ていない場合は字幕は生成されません

## API ごとの注意

### Deepgram

- 使用モデルは `nova-3`
- タブ音声を 16kHz mono PCM に変換して送信しています

### Cloud Translation

- `Basic v2` を使用します
- Google Cloud 側で `Cloud Translation API` の有効化と課金設定が必要です
- API key には `Cloud Translation API` の利用制限を付けることを推奨します

### Gemini

- 生成モデルのため、Cloud Translation より遅延や揺れが出ることがあります
- ストリーミング更新の都合で、文の途中で表現が差し替わることがあります

## トラブルシュート

### `開始に失敗しました`

- 対象タブが `chrome://*` などの非対応ページでないか確認してください
- 前回のタブキャプチャが残っている場合は、数秒待ってから再試行してください
- 拡張を再読み込みしてから `停止 -> 開始` を試してください

### `音声を待機しています…` のまま進まない

- 対象タブで実際に音声が再生されているか確認してください
- タブ自体がミュートされていないか確認してください
- Deepgram API Key が正しいか確認してください

### 翻訳が出ない / 不安定

- Cloud Translation を選んでいる場合
  - `Cloud Translation API` が有効化されているか確認してください
  - API key 制限が厳しすぎないか確認してください
- Gemini を選んでいる場合
  - モデルと API Key が正しいか確認してください
  - 生成系の都合で返答が揺れることがあります

### 区切りが不自然

- `字幕の区切り` を `標準` または `自然` に上げてください
- 低遅延モードは速さ優先なので、細かく切れやすいです

## 開発メモ

- `npm run build` で `src/` と `public/` から `dist/` を生成します
- `dist/` は配布用生成物であり、Git では追跡しません
- 追加の runtime dependency は `@deepgram/sdk` のみです

## ファイル構成

- `src/background.js`
  - セッション開始/停止、offscreen 制御、content script 注入
- `src/offscreen.js`
  - タブ音声取得、AudioWorklet、Deepgram STT、Cloud Translation / Gemini 翻訳
- `src/content.js`
  - ページ上の字幕オーバーレイ描画、ドラッグ移動、状態表示
- `src/popup.js`
  - popup UI と設定保存
- `src/ui-copy.js`
  - UI 文言、ラベル、状態表示
- `src/audio-worklet.js`
  - PCM 変換と音量通知
- `public/manifest.json`
  - MV3 manifest、権限、popup、icon 定義
- `build.mjs`
  - ビルドスクリプト
