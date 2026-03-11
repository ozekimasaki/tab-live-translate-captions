# AGENTS.md

## 言語

- 思考は英語で行い、ユーザーへの回答は日本語で行う。

## プロジェクト概要

- このリポジトリは Chrome Manifest V3 拡張です。
- 現在のタブ音声を取得し、Deepgram でリアルタイム音声認識し、Cloud Translation または Gemini で翻訳した字幕をページ下部にオーバーレイ表示します。
- 実装は完全にクライアントサイドです。API キーは `chrome.storage.local` に保存し、サーバー中継はありません。
- ビルド成果物は `dist/` に出力されます。`dist/` は生成物なので直接編集しません。

## 技術スタックとビルド

- 実装は `src/` 配下のプレーンな ES Modules JavaScript です。
- 静的ファイルと拡張メタデータは `public/` にあります。
- バンドルは [`build.mjs`](C:\Users\masam\Documents\deepfram_extension\build.mjs) の `esbuild` で行います。
- 現在のビルドコマンドは `npm run build` のみです。
- 出力形式は IIFE、ターゲットは Chrome 120 です。

## 主要ファイル

- [`src/background.js`](C:\Users\masam\Documents\deepfram_extension\src\background.js)
  セッション開始/停止、popup とのメッセージ処理、content script 注入、badge 更新、offscreen 制御、stale state の掃除を担当します。
- [`src/offscreen.js`](C:\Users\masam\Documents\deepfram_extension\src\offscreen.js)
  タブ音声取得、AudioWorklet による PCM 変換、Deepgram 接続、字幕区切り、翻訳キュー処理、background へのイベント通知を担当します。
- [`src/content.js`](C:\Users\masam\Documents\deepfram_extension\src\content.js)
  ページ上の字幕オーバーレイ描画、ドラッグ移動、fullscreen 時の再配置、再注入時の状態引き継ぎを担当します。
- [`src/popup.js`](C:\Users\masam\Documents\deepfram_extension\src\popup.js)
  popup UI、設定保存、開始/停止アクション、`chrome.storage` ベースの再描画を担当します。
- [`src/constants.js`](C:\Users\masam\Documents\deepfram_extension\src\constants.js)
  メッセージ種別、設定初期値、翻訳プロバイダ、Gemini モデル、セッション状態、対応言語ペアの共通契約です。
- [`src/storage.js`](C:\Users\masam\Documents\deepfram_extension\src\storage.js)
  `chrome.storage.local` の薄いラッパーです。
- [`src/ui-copy.js`](C:\Users\masam\Documents\deepfram_extension\src\ui-copy.js)
  popup と overlay の表示文言、選択肢定義をまとめています。
- [`src/page-support.js`](C:\Users\masam\Documents\deepfram_extension\src\page-support.js)
  非対応プロトコルと非対応ページの判定を持ちます。
- [`public/manifest.json`](C:\Users\masam\Documents\deepfram_extension\public\manifest.json)
  MV3 権限、host permissions、popup、`web_accessible_resources` を定義します。
- [`public/content.css`](C:\Users\masam\Documents\deepfram_extension\public\content.css)
  オーバーレイのスタイルです。
- [`public/popup.html`](C:\Users\masam\Documents\deepfram_extension\public\popup.html)
- [`public/popup.css`](C:\Users\masam\Documents\deepfram_extension\public\popup.css)
  popup のマークアップとスタイルです。

## 実行フロー

1. `popup.js` が background から状態を取得し、`START_SESSION` / `STOP_SESSION` / `SETTINGS_UPDATED` を送ります。
2. `background.js` がアクティブタブを検証し、必要なら content layer を注入し、offscreen document を作成してセッション状態を保存します。
3. `offscreen.js` が `tabCapture` で音声を取得し、`audio-worklet.js` で 16kHz mono PCM に変換し、Deepgram に流して翻訳キューへ渡します。
4. `content.js` が transcript / translation / status を受け取り、オーバーレイを更新します。ドラッグ位置は background 経由で保存されます。

## 現在の不変条件

- メッセージ名は `src/constants.js` の `MESSAGE_TYPES` が単一の契約です。追加や改名をする場合は送信側と受信側を同時に更新します。
- セッションは常に 1 つだけです。`background.js` は新しい開始時に既存セッションを停止する前提です。
- 言語ペアは `PRESET_LANGUAGE_PAIRS` に限定されています。`background.js` で不正な組み合わせは正規化されます。
- 非対応ページの判定は `src/page-support.js` が正です。content script を注入できないページを無理に通さないでください。
- `src/offscreen.js` は `audio-worklet.js` が bundle され、かつ `web_accessible_resources` に含まれている前提です。移動や改名時は `build.mjs` と `public/manifest.json` を両方更新します。
- `src/content.js` は `window.__deepframOverlayController` を使って再注入時の状態を引き継ぎます。この挙動は壊しやすいので、置き換えるなら end-to-end で設計し直してください。
- popup のプロバイダ別入力欄は `#appRoot[data-provider="..."]` と `.provider-field` の組み合わせで表示制御しています。
- API キーなどの秘密情報をログ出力しません。

## 変更時の指針

- 設定項目を追加する場合:
  `src/constants.js` の `DEFAULT_SETTINGS`、`src/background.js` の normalize/validate、`src/popup.js` のフォーム処理、必要なら `src/ui-copy.js` と `README.md` を更新します。
- 翻訳プロバイダやモデルを追加する場合:
  定数、popup 選択肢、validation、offscreen の翻訳処理、必要なら `manifest.json` の host permissions を更新します。
- 新しいメッセージを追加する場合:
  先に `MESSAGE_TYPES` を更新し、その後 sender、background/offscreen/content 側の handler、状態遷移を揃えます。
- オーバーレイ UI を変更する場合:
  ドラッグ保存、fullscreen 対応、placeholder/status 表示、再注入時の state 維持を壊さないことを優先します。
- 音声処理や STT を変更する場合:
  `tabCapture` の解放、offscreen teardown、auto-stop、Deepgram keep-alive の後始末を維持してください。

## 確認手順

- 意味のある変更後は `npm run build` を実行します。
- 実機確認は `dist/` を Chrome の unpacked extension として読み込みます。
- ランタイム変更時の最低限の確認:
  通常の `https://` ページで音声再生中に開始し、オーバーレイ表示、停止、再開始時の前セッション cleanup を確認します。
- popup 設定変更時:
  popup を閉じて開き直しても設定が保持されること、プロバイダ別入力欄の出し分けが崩れていないことを確認します。
- overlay 変更時:
  ドラッグ位置の保存、再注入後の状態維持、fullscreen 切り替え時の表示を確認します。
  短い確定字幕が即消えせず少し保持されること、保持中に順序が逆転しないことも確認します。
- 翻訳ランタイム変更時:
  Cloud Translation / Gemini の一時停止や遅延で全体が固まらないこと、1 回再試行後に partial または fallback で先へ進めることを確認します。
- 現状、専用の test script や lint script はありません。手動確認が基本です。

## 実装上の好み

- 明示的な要件がない限り、プレーンな JavaScript のまま拡張します。
- 同じ状態定義や文言定義を重複追加するより、既存の constants/helpers を延長してください。
- 機能の挙動を変えたら `README.md` と `AGENTS.md` も実装に合わせて更新します。
