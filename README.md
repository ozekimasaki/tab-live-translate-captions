# Deepfram Extension

Deepgram と Gemini を使って、現在の Chrome タブ音声をリアルタイム翻訳字幕としてオーバーレイ表示する MV3 拡張です。

## Build

```bash
npm install
npm run build
```

ビルド後の拡張本体は `dist/` に出力されます。

## Load in Chrome

1. `chrome://extensions` を開く
2. `デベロッパーモード` を有効化
3. `パッケージ化されていない拡張機能を読み込む` で `dist/` を選ぶ

## Usage

1. 拡張 popup を開く
2. `Deepgram API Key` と `Gemini API Key` を入力する
3. `翻訳方向`、`表示モード`、`字幕の区切り`、`原文プレビュー`、`背景の濃さ` を設定する
4. 字幕を出したいタブをアクティブにした状態で `開始` を押す
5. ページ下部の字幕バーをドラッグして位置を移動する

## Current Constraints

- 対応ページは通常の `http/https` ページです。`chrome://*`、Chrome Web Store などの制限ページでは開始できません。
- API Key は `chrome.storage.local` に保存します。完全な秘匿は保証しません。
- Gemini 翻訳は `final` 確定文のみ送信します。原文プレビューは表示のみで、翻訳 API 呼び出しには使いません。
- セッションは 1 つだけです。別タブで開始した場合は前のセッションを停止します。
- Deepgram モデルは `nova-3`、Gemini モデルは `gemini-3.1-flash-lite-preview` を使います。

## Files

- `src/background.js`: セッション開始/停止、offscreen 制御、content script 注入
- `src/offscreen.js`: タブ音声取得、Deepgram STT、Gemini 翻訳
- `src/content.js`: 字幕オーバーレイ描画、ドラッグ移動
- `src/popup.js`: 設定 UI
- `src/ui-copy.js`: UI 文言、ラベル、状態表示の共通化
- `src/audio-worklet.js`: PCM 変換
