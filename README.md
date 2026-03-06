# Deepfram Extension

Deepgram と Cloud Translation / Gemini を使って、現在の Chrome タブ音声をリアルタイム翻訳字幕としてオーバーレイ表示する MV3 拡張です。

## Build

```bash
npm install
npm run build
```

ビルド後の拡張本体は `dist/` に出力されます。
`dist/` は生成物なので Git では追跡しません。

## Load in Chrome

1. `chrome://extensions` を開く
2. `デベロッパーモード` を有効化
3. `パッケージ化されていない拡張機能を読み込む` で `dist/` を選ぶ

## Usage

1. 拡張 popup を開く
2. `翻訳プロバイダ` を選ぶ
3. `Deepgram API Key` と、選択した翻訳プロバイダの API Key を入力する
4. `Gemini` を使う場合は `Gemini モデル` を選ぶ
5. `翻訳方向`、`表示モード`、`字幕の区切り`、`原文プレビュー`、`背景の濃さ` を設定する
6. 字幕を出したいタブをアクティブにした状態で `開始` を押す
7. ページ下部の字幕バーをドラッグして位置を移動する

## Current Constraints

- 対応ページは通常の `http/https` ページです。`chrome://*`、Chrome Web Store などの制限ページでは開始できません。
- API Key は `chrome.storage.local` に保存します。完全な秘匿は保証しません。
- Cloud Translation は `Basic v2` を使います。Google Cloud 側で `Cloud Translation API` の有効化と課金設定が必要です。
- 翻訳は `final` 確定文のみ送信します。原文プレビューは表示のみで、翻訳 API 呼び出しには使いません。
- セッションは 1 つだけです。別タブで開始した場合は前のセッションを停止します。
- Deepgram モデルは `nova-3` を使います。Gemini は `gemini-2.5-flash-lite` と `gemini-3.1-flash-lite-preview` を切り替えられます。
- Cloud Translation を使う場合は、API key に `Cloud Translation API` の制限をかけることを推奨します。

## Files

- `src/background.js`: セッション開始/停止、offscreen 制御、content script 注入
- `src/offscreen.js`: タブ音声取得、Deepgram STT、Cloud Translation / Gemini 翻訳
- `src/content.js`: 字幕オーバーレイ描画、ドラッグ移動
- `src/popup.js`: 設定 UI
- `src/ui-copy.js`: UI 文言、ラベル、状態表示の共通化
- `src/audio-worklet.js`: PCM 変換
