# AGENTS.md

## 言語

- 思考は英語で行い、ユーザーへの回答は日本語で行う。

## プロジェクト概要

- このリポジトリは Chrome Manifest V3 拡張です。
- 現在のタブ音声を取得し、Deepgram または Grok / xAI で音声認識し、Cloud Translation または Gemini で翻訳した字幕をページ下部にオーバーレイ表示します。
- 実装は完全にクライアントサイドです。API キーは `chrome.storage.local` に保存し、サーバー中継はありません。
- ビルド成果物は `dist/` に出力されます。`dist/` は生成物なので直接編集しません。

## 技術スタックとビルド

- 実装は `src/` 配下のプレーンな ES Modules JavaScript です。
- 静的ファイルと拡張メタデータは `public/` にあります。
- バンドルは [`build.mjs`](build.mjs) の `esbuild` で行います。
- エントリーポイントは `background.js`、`content.js`、`popup.js`、`offscreen.js`、`audio-worklet.js` です。
- 出力形式は IIFE、ターゲットは Chrome 120 です。
- 現在のビルドコマンドは `npm run build` のみです。
- 追加の runtime dependency は `@deepgram/sdk` のみです。
- lint / test script はまだありません。確認は `npm run build` と実機確認が基本です。

## 主要ファイル

- [`src/background.js`](src/background.js)
  popup とのメッセージ処理、設定の normalize / validate、content script 注入、offscreen 制御、badge 更新、stale session cleanup を担当します。
- [`src/offscreen.js`](src/offscreen.js)
  タブ音声取得、AudioWorklet による 16kHz mono PCM 変換、Deepgram / xAI の STT 分岐、字幕区切り、翻訳キュー、retry / fallback、background へのイベント通知を担当します。
- [`src/content.js`](src/content.js)
  ページ上の字幕オーバーレイ描画、ドラッグ移動、fullscreen 時の再配置、再注入時の状態引き継ぎ、短い確定字幕の一時保持を担当します。
- [`src/popup.js`](src/popup.js)
  popup UI、設定保存、開始 / 停止アクション、recent runtime logs の表示 / コピー / クリア、`chrome.storage` 監視ベースの再描画を担当します。
- [`src/constants.js`](src/constants.js)
  storage key、表示モード、字幕区切りモード、翻訳プロバイダ、Gemini モデル、言語ペア、デフォルト設定、メッセージ種別、セッション状態の共通契約です。
- [`src/storage.js`](src/storage.js)
  `chrome.storage.local` に対する settings / sessionState / runtimeLogs の薄いラッパーです。
- [`src/ui-copy.js`](src/ui-copy.js)
  popup / overlay の表示文言、選択肢定義、状態表示の view model をまとめています。
- [`src/page-support.js`](src/page-support.js)
  非対応プロトコルと非対応ホストの判定を持ちます。
- [`src/audio-worklet.js`](src/audio-worklet.js)
  タブ音声を downsample して Int16 PCM に変換し、音量と無音継続時間を offscreen へ通知します。
- [`public/manifest.json`](public/manifest.json)
  MV3 権限、host permissions、popup、icon、`web_accessible_resources` を定義します。
- [`public/offscreen.html`](public/offscreen.html)
  offscreen document のエントリ HTML です。`offscreen.js` を読み込みます。
- [`public/content.css`](public/content.css)
  オーバーレイのスタイルです。
- [`public/popup.html`](public/popup.html)
- [`public/popup.css`](public/popup.css)
  popup のマークアップとスタイルです。

## 実行フロー

1. `popup.js` が background から状態を取得し、`GET_STATE` / `SETTINGS_UPDATED` / `START_SESSION` / `STOP_SESSION` を送ります。
2. `background.js` が設定を normalize / validate し、対象タブを検証し、必要なら content layer を注入し、offscreen document を作成してセッション状態を保存します。
3. `offscreen.js` が `tabCapture` の stream ID と `getUserMedia` を使って音声を取得し、`audio-worklet.js` で 16kHz mono PCM に変換します。Deepgram 選択時は realtime streaming、xAI 選択時は短い発話区間ごとに HTTPS STT へ送ります。
4. Deepgram は token boundary ベース、xAI は local VAD ベースの発話区間管理で字幕区間を確定し、区間ごとに翻訳タスクへ積みます。Deepgram は interim transcript から speculative translation を先行表示でき、xAI は turn 完了後の translation streaming で near realtime に寄せます。
5. 翻訳は最大 2 並列で処理し、必要に応じて partial / final を順序保証付きで送ります。overlay は `latencyPreference` に応じて表示 hold を変えます。
6. `background.js` が offscreen イベントを session state / badge / content overlay に反映し、`content.js` が transcript / translation / status を受けてオーバーレイを更新します。ドラッグ位置は background 経由で保存されます。
7. 停止・エラー・ページ再読み込み・タブ close・stale state 検知時は offscreen と overlay を teardown し、状態を idle に戻します。

## 現在の不変条件

- メッセージ名は `src/constants.js` の `MESSAGE_TYPES` が単一の契約です。追加や改名をする場合は sender / receiver を同時に更新します。
- セッションは常に 1 つだけです。新しい開始時は既存セッションを停止します。
- 対応ページ判定は `src/page-support.js` が正です。`http/https` の通常ページのみ対象で、`chrome://*`、Chrome Web Store などでは開始できません。
- 言語ペアは `PRESET_LANGUAGE_PAIRS` に限定されています。`background.js` の `normalizeSettings()` が source language に対応する target language へ正規化し、`validateSettings()` が不正ペアを拒否します。
- STT provider は `DEFAULT_SETTINGS.sttProvider` と `STT_PROVIDERS` が契約です。現在は `deepgram` / `xai` を持ち、xAI 用 API key は `xaiApiKey` に保存します。
- xAI STT は現在 `英語` / `日本語` 入力のみ対応です。`中国語 → 日本語` を使う場合は `Deepgram` を選ぶ前提です。
- `chrome.storage.local` 上の永続状態は `settings`、`sessionState`、`runtimeLogs` です。読み書きは `src/storage.js` を通す前提です。
- active session のランタイム正本は offscreen document 側です。`background.js` は起動時と `GET_STATE` 時に offscreen 不在 / タブ消滅を検知すると stale session を cleanup します。
- `src/offscreen.js` は `audio-worklet.js` が bundle され、かつ `web_accessible_resources` に含まれている前提です。移動や改名時は `build.mjs` と `public/manifest.json` を両方更新します。
- `src/content.js` は `window.__deepframOverlayController` の `exportState()` / `destroy()` で再注入時の状態を引き継ぎます。fullscreen 時は host 要素へ再配置します。この挙動は壊しやすいです。
- オーバーレイ位置の実装は現在 `overlayOffset` のみを使います。`DEFAULT_SETTINGS.overlayAnchor` は存在し live patch にも含まれますが、`content.js` では未使用です。
- `SETTINGS_UPDATED` は実行中セッションにも一部 live 反映されます。表示モード / 字幕区切り / 原文プレビュー / オーバーレイ系設定は反映されます。STT プロバイダ / 翻訳プロバイダ / Gemini モデルの hot-swap はせず、翻訳方向は実行中セッションで STT プロバイダを切り替えていないときだけ反映されます。`sessionState` は `runtimeSessionId` と開始時の STT / 翻訳 / 言語ペア / Gemini モデルのスナップショットを保持します。
- `showSourcePreview` が false のとき、offscreen は partial transcript を送信しません。
- `latencyPreference` は `DEFAULT_SETTINGS` / popup / background live patch / offscreen tuning / content hold が同じ契約です。追加・変更時は全部そろえて更新してください。
- 翻訳結果は `sequenceId` ベースで順序保証されます。Gemini の streaming partial と final が前後しても、表示順が崩れない前提です。
- `content.js` は短い確定字幕を少し保持してから次の字幕へ切り替えます。字幕切替順序と保持タイマーを壊さないでください。
- 翻訳は 2 回まで試行します。timeout / stall / network / empty / 5xx / 429 / 408 は再試行対象で、最終的には partial か固定文言で先へ進みます。
- 5 分以上発話を検知しないと offscreen は自動停止し、background へエラー通知を送ります。
- ブラウザの WebSocket API では `Authorization` header を自由に付けられず、xAI STT docs でも browser 向けの `/v1/stt` 認証回避フローは確認できません。extension-only 構成では xAI realtime WebSocket を前提にしません。
- extension-only の xAI は短い発話区間ごとの HTTPS STT を前提にし、低遅延化は local VAD と flush 設定で詰めます。
- popup で見える runtime logs は上限付きの recent diagnostics です。完全な telemetry / 永続監査ログとしては扱いません。
- popup から runtime logs を表示 / コピー / クリアできる前提です。
- API キーなどの秘密情報をログ出力しません。

## 変更時の指針

- 設定項目を追加する場合:
  `src/constants.js` の `DEFAULT_SETTINGS`、`src/background.js` の normalize / validate / live patch、`src/popup.js` のフォーム処理、必要なら `src/content.js` / `src/offscreen.js` / `src/ui-copy.js` / `README.md` / `AGENTS.md` を更新します。
- STT provider を追加する場合:
  selector の定数、API key の保存、`background.js` の normalize / validate / sessionState、`popup.js` の出し分け、`offscreen.js` の provider 分岐、必要なら host permissions を更新します。xAI は extension-only では HTTPS STT ベースで扱い、provider ごとの対応入力言語制約を popup と validate の両方で揃えてください。
- 翻訳プロバイダやモデルを追加する場合:
  定数、popup 選択肢、background validation、offscreen の翻訳実装、必要なら `manifest.json` の host permissions を更新します。
- 新しいメッセージを追加する場合:
  先に `MESSAGE_TYPES` を更新し、その後 sender、background / offscreen / content 側の handler と状態遷移を揃えます。
- オーバーレイ UI を変更する場合:
  ドラッグ位置保存、fullscreen 対応、placeholder / status 表示、再注入時の state 維持、短い確定字幕の hold、partial / final の表示順を壊さないことを優先します。
- 音声処理や STT を変更する場合:
  `tabCapture` の解放待ち、offscreen teardown、Deepgram keep-alive、auto-stop、token buffer と boundary 判定の整合性を維持してください。xAI を変更する場合は発話区間 flush、HTTPS retry、cleanup / error recovery を揃えます。
- build entry やファイル名を変更する場合:
  `build.mjs`、`public/manifest.json`、必要なら `public/offscreen.html` を同時に更新します。

## 確認手順

- 意味のある変更後は `npm run build` を実行します。
- 実機確認は `dist/` を Chrome の unpacked extension として読み込みます。
- ランタイム変更時の最低限の確認:
  通常の `https://` ページで音声再生中に開始し、オーバーレイ表示、停止、再開始時の前セッション cleanup、タブ close / reload 時の自動停止を確認します。Deepgram / xAI の両方で開始できることも確認します。
- popup 設定変更時:
  popup を閉じて開き直しても設定が保持されること、STT / 翻訳プロバイダ別入力欄の出し分けが崩れていないこと、xAI 選択時に `中国語 → 日本語` が無効化されること、`リアルタイム優先度` が保存されて live patch でも反映されること、storage 変更で UI が再描画されること、runtime logs の表示 / コピー / クリアが動くことを確認します。
- overlay 変更時:
  ドラッグ位置の保存、再注入後の状態維持、fullscreen 切り替え時の表示、短い確定字幕の保持、partial / final の順序維持を確認します。
- 翻訳ランタイム変更時:
  Cloud Translation / Gemini の timeout / stall / retry / fallback で全体が固まらないこと、partial または固定文言で継続表示されることを確認します。

## 実装上の好み

- 明示的な要件がない限り、プレーンな JavaScript のまま拡張します。
- 同じ状態定義や文言定義を重複追加するより、既存の constants / helpers を延長してください。
- `dist/` は直接編集しません。
- 機能の挙動を変えたら `README.md` と `AGENTS.md` を実装に合わせて更新します。
