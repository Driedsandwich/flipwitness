# PatchWitness model stage — Order 04

audience: maintainers

モデル3段階、予算台帳、API、画面の接続を実装しました。実モデルへの呼出しと支出は0です。確認済みなのはモック、通信なしのHTTP応答差替え、Node実行器です。実ソケットのスタブテストは実装済みですが、この環境では待受けが `EPERM` で拒否されたため6件をスキップしました。実モデルの品質は一切実証していません。

**設計と再現方法。** 依存追加やビルドはありません。次のコマンドは外部通信を行いません。

```sh
node --test tests/
node scripts/mock-flow.mjs
node scripts/mock-flow.mjs --write
```

最後のコマンドは3サンプルの `precomputed.json` を再生成します。各ファイルの最上位に `"source": "mock"` と `"cost": 0` を記載しています。内部のセッション費用は架空の `usage` による計算例です。CLIの `cost` は実支出、`simulated_usd` はその計算例の累計です。ラウンド0が初回、1と2が書き直しです。名前検証サンプルには `fetch` を含む回答を入れ、実行前の拒否と修復を検証しています。

`server/models.mjs` は提供されたモデルIDと価格を保持します。`llm.mjs` は `complete({model, messages, responseFormat, maxTokens, temperature})` を提供します。HTTP実装はキーを呼出し時に環境から読み、429と5xxだけを既定で最大2回再試行します。全試行に共通の8秒の打切りを設定し、`Retry-After` が残り時間を超える場合は待機せず失敗します。数値秒とHTTP日付を扱います。通信例外とプロバイダーのエラー本文を外へ出しません。通信なしの `fetchImpl` 差替えでこれらの分岐を検証しています。

`jsonout.mjs` の出力形式は `PW_SCHEMA_STYLE` 一つで切り替えます。値は `openai`（既定）、`nebius_doc`、`json_object`、`none` です。JSONから `think` 要素を除き、JSONフェンスまたは最初の釣り合ったオブジェクトを受け入れます。別フィールドの `reasoning_content` は使いません。型、必須項目、列挙値、文字数、配列の項目数、追加プロパティを検査します。JSON・スキーマ・静的ゲートのいずれかが不合格なら理由だけを添えて一度修復します。各段階は合計最大2回答で、その後は `upstream_error` です。

`stages.mjs` は抽出をNano、仮説をUltra、テスト作成をSuperへ渡します。実在しないファイルの仮説は除去します。テストは `@entry` と `@patchwitness/harness` からだけインポートできます。入口ファイル名もプロンプトへ渡します。8 KiBの上限と禁止語、インポート先、`test(` の有無を実行前に検査します。**静的ゲートはフィルターであり、セキュリティ境界ではありません。** 文字列やコメント内の禁止語にも反応する保守的な検査です。既存のブラウザ用インポート走査器の構文制限も引き継ぎます。詳しくは [CORE_NOTES.md](CORE_NOTES.md) を参照してください。

`web/flow.mjs` が抽出、仮説、テスト作成を順に呼び、前後の結果を対応付けます。証拠がなければ結果を返して最大2回書き直します。証拠がある場合は `patch_suspect` でも止まります。画面は `runner.browser.mjs` の専用Web Workerへだけ実行を委ねます。サーバーのAPIは提出コードも生成テストも実行しません。CLIとテストだけが既存のNode実行器を注入します。

画面はサンプルの事前計算結果を費用0で表示します。サンプルでの “Generate tests with Nemotron” は事前計算結果を表示し、別の “Run live” がAPIを呼びます。貼付けモードではファイル名とソースのJSONオブジェクト、入口、報告、差分を入力してAPIを使います。ラウンドごとの全テスト結果と生成ソース、モデルID、費用、予算拒否時の事前計算結果へのリンクを表示します。指定の共有注意文も表示します。

**予算と権限。** `PW_LIVE` は既定で無効です。ライブの有効化には `PW_LIVE=1` と正の `PW_GRANTED_CREDITS_USD` が必要です。後者は両アプリ合計の付与クレジット総額で、残額ではありません。キーは `NEBIUS_API_KEY`、任意の審査用合言葉は `PW_JUDGE_PASSPHRASE` だけから読みます。キーや合言葉を引数、ログ、台帳、エラー本文へ保存しません。合言葉は固定長ダイジェストの `timingSafeEqual` で比較し、不一致はpublicです。セッションIDはサーバーが発行し、段階順序、レーン固定、テスト作成最大3ラウンドも台帳から検査します。

セッションは通算 $0.08、pwの制作期間は2026-10-23〜10-30通算 $5.00、2026-10-31〜11-30は1日 $0.10、2026-12-01〜12-16はjudgeが1日 $0.40、publicが1日 $0.15です。日付はAsia/Tokyoです。期間外は呼び出せません。全期間・両アプリ通算 $45.00 と設定済み付与クレジット額の小さい方も適用します。ek独自の上限は強制しません。

各呼出しの直前に、プロンプトの文字数÷3を切り上げた入力トークン数と最大出力トークン数から費用を見積もります。HTTPの再試行可能数も含めて入場判定します。成功は `usage.prompt_tokens` と `usage.completion_tokens` で計算します。`prompt_tokens_details.cached_tokens` が有効な整数なら提供価格のキャッシュ割引を適用します。このフィールドが実サービスで返るかは未確認です。使用量がなければ出力文字数÷3も使い、`estimated: true` を台帳へ記録します。APIには `cost_estimated` も返します。失敗試行の課金は不明なので、その試行の入場見積額を保守的に記録します。JSON修復も別呼出しとして上限判定します。

台帳は `$X129_LEDGER_PATH`、未設定なら `~/.x129/ledger.jsonl` です。既存行の必須形式は次のとおりです。

```json
{"app":"pw","lane":"public","day":"2026-10-24","amount":0.0001,"session":"server-generated-id","stage":"extract","estimated":false}
```

`app` はpwかek、`lane` はpublicかjudge、`day` は有効な日付、`amount` は有限かつ非負のUSDです。余分なフィールドを許容します。段階開始・完了は同じ形式の金額0の行です。JSON不正、空行、不正な必須値が一つでもあると呼出しを拒否します。金額はUSDの浮動小数です。

Nodeの実装は隣接する `.lock` を排他的作成で取得し、入場判定から応答の記録まで保持します。待機上限は1秒、古いロックの期限は120秒です。**Python側の `fcntl.flock` とこのロックファイルは相互排他になりません。同一マシンで両アプリを同時使用しても直列化されません。** 同時ライブ使用の前には共通のトランザクション対応ストアまたは共通のロック方式が必要です。プロセス強制終了からの完全な課金復元も保証しません。未完了セッションを再利用せず、プロバイダーの使用量と照合してください。

アプリはプロバイダーのクレジット残高や現金請求設定を検証できません。文字数によるトークン見積もりも厳密な上限ではありません。**自己資金 $0 は実際のプロバイダーの請求設定でも担保する必要があります。** 付与クレジットのみで消費でき、現金の自動支払い・不足分請求が発生しないと確認できるまで `PW_LIVE` を有効にしてはいけません。対応設定の有無は未確認です。本オーダーでは無効のまま、実支出0で完了しています。

`api.mjs` はHTTPから独立した `handle(requestJson, env, deps)` です。入力全体は64,000バイト、報告は4,000文字、ソース合計は12,000バイト、差分は16,000バイトです。最大20ファイルです。返却は段階JSONと `session`、`model`、`rateHeaders`、`cost`、`cost_estimated`、`remaining_session_usd` です。拒否コードは `budget`、`too_large`、`bad_request`、`upstream_error` です。書き直し結果は最大50件、各メッセージは1,000文字へ制限します。

`serve.mjs` は127.0.0.1用の薄いアダプターです。サーバー内部・台帳を配信せず、web/core/samplesの公開用ファイルだけを配信します。`server/serverless.mjs` はWeb Request/Responseの汎用アダプターです。**unverified until deploy**。特定プラットフォームへの対応を主張しません。デプロイ先のNode機能・共有台帳・永続性を検証し、JSONL実装を共有の永続トランザクションストアへ置換する必要があります。

**出典と未確認事項。** 以下はOrder 04に提供された2026-10-24の公式資料スナップショットです。この作業では外部サイトを取得していません。

- 接続先と認証の提供値は `https://api.tokenfactory.nebius.com/v1/`、`chat/completions`、`Authorization: Bearer <key>` です。[Token Factory quickstart](https://docs.tokenfactory.nebius.com/quickstart.md)
- モデルIDと1Mトークン当たりUSDは下表の提供値をそのまま使用しました。[公式モデルカタログ](https://tokenfactory.nebius.com/model-catalog.md)

| 役割 | モデルID | 入力USD / 1M | キャッシュ入力USD / 1M | 出力USD / 1M |
| --- | --- | ---: | ---: | ---: |
| Nano | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 0.06 | 未提示 | 0.24 |
| Super | `nvidia/nemotron-3-super-120b-a12b` | 0.30 | 0.06 | 0.90 |
| Ultra | `nvidia/Nemotron-3-Ultra-550b-a55b` | 1.00 | 0.12 | 3.00 |

- 構造化出力の提供値は `"type": "json_schema"` または `"type": "json_object"` です。資料例の直接スキーマとOpenAI形式のラッパーのどちらが受理されるか、各Nemotron 3が対応するかは不明です。既定のopenaiは互換性確認のための仮定です。[構造化出力資料](https://docs.tokenfactory.nebius.com/ai-models-inference/json.md)
- 制限超過は `HTTP 429`、提供されたヘッダー名は `x-ratelimit-remaining-requests`、`x-ratelimit-remaining-tokens`、`x-ratelimit-over-limit` です。実際の値や上限は未測定です。[レート制限資料](https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits.md)
- reasoningの出力形式、実トークン数、キャッシュの使用量フィールド、モデルによるテストの質も未確認です。

標準APIの参照先は [Node fetch](https://nodejs.org/docs/latest-v22.x/api/globals.html#fetch)、[AbortSignal.timeout](https://nodejs.org/docs/latest-v22.x/api/globals.html#static-method-abortsignaltimeoutdelay)、[ファイルシステム](https://nodejs.org/docs/latest-v22.x/api/fs.html)、[timingSafeEqual](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptotimingsafeequala-b) です。これらのページは未取得です。今回のAPI使用の根拠はローカル実行による検証です。既存コアのNode実行フラグについては [CORE_NOTES.md](CORE_NOTES.md) のローカル `node --help` 引用を参照してください。

**初回ライブチェックリスト（未実施、最大6呼出し）。** 事前条件は上記のクレジットのみの請求確認、期間内の日付、共有台帳の排他性、本人が許可したキー設定です。小さな月末サンプルだけを使います。HTTPクライアントの `maxRetries: 0` を指定し、JSON修復・テスト書き直しは無効にします。通常の `runStage` や画面からではなく、予算で包んだ `complete` を1回ずつ呼び、返答を `parseJSON` / `validate` で調べます。失敗を修復呼出しで増やしません。機微情報とreasoningは記録せず、モデルID、形式、成否、usage、費用、3種のレート制限ヘッダーだけを記録します。

1. Nano、`nebius_doc`、最大出力256トークン。短い報告の抽出スキーマを直接指定します。
2. Nano、`openai`、同じ報告・スキーマ、最大出力256トークン。ラッパー形式の受理を比較します。
3. Nano、`json_object`、同じ報告・プロンプト、最大出力256トークン。手元で検証します。
4. Nano、`none`、同じ報告・プロンプト、最大出力256トークン。形式指定なしのJSON出力を検証します。
5. Ultra、受理できた形式、最大出力512トークン。小さな月末ソースと良い差分から1仮説を求め、ファイル名と説明を確認します。受理可能な形式がなければ以降を止めます。
6. Super、受理できた形式、最大出力768トークン。候補テストを静的検査し、ブラウザの前後実行を観察します。追加のモデル呼出しは行いません。

各呼出しの入力見積もりを最大1,800トークンに収めると、キャッシュ割引なしの合計見積もりは $0.005245 です。目安は $0.006 未満、要求上限 $0.05 未満です。実費はusageで記録し、残額が不足する場合は入場判定で止めます。これは料金・トークン数の実測ではありません。

**確認結果。** 既存29テストは保持しています。追加テストはモックフロー、全禁止語、修復回数、台帳の永続化・古いロック・同時呼出し、JST境界、各上限、API入力・レーン・秘密情報非露出、Node/Webアダプターを含みます。ブラウザの画面操作とWeb Workerの実ブラウザ実行は、まだ観察していません。デプロイ、Tavily、ライセンス本文はこの変更に含みません。

スキップした6件は、全4形式の実HTTP検証、429と4xxの実HTTP検証、500と長いRetry-Afterの実HTTP検証、不正JSONの実HTTP修復、良い月末パッチの実HTTP全工程、不完全な月末パッチの実HTTP全工程です。すべて実際の `listen(0, '127.0.0.1')` 失敗時だけスキップします。通信なしの差替え試験が成功しても、実ソケット試験の成功とは扱いません。

最終テスト出力は後述の記録です。

```text
1..69
# tests 69
# suites 0
# pass 63
# fail 0
# cancelled 0
# skipped 6
# todo 0
# duration_ms 2093.329791
```

15モジュールの `node --check` と画面内の固定ID参照の検査も成功しました。これは画面描画・操作・Worker実行の検証ではありません。

`node scripts/mock-flow.mjs` の実測出力に対応する表です。費用は実支出USDです。初回をラウンド0とします。

| sample | patch | round | witnesses | verdict | cost USD |
| --- | --- | ---: | ---: | --- | ---: |
| month-end | good | 0 | 0 | no_evidence | 0 |
| month-end | good | 1 | 3 | supported | 0 |
| month-end | incomplete | 0 | 0 | no_evidence | 0 |
| month-end | incomplete | 1 | 2 | patch_suspect | 0 |
| name-check | good | 0 | 2 | supported | 0 |
| name-check | incomplete | 0 | 1 | patch_suspect | 0 |
| csv-line | good | 0 | 3 | supported | 0 |
| csv-line | incomplete | 0 | 2 | patch_suspect | 0 |

新規ファイル: `server/models.mjs`, `server/llm.mjs`, `server/jsonout.mjs`, `server/stages.mjs`, `server/budget.mjs`, `server/api.mjs`, `server/runtime.mjs`, `server/serverless.mjs`, `web/flow.mjs`, `scripts/mock-flow.mjs`, `tests/model-stage.test.mjs`, `tests/budget-api.test.mjs`, `tests/fixtures/mock_scripts/month-end.json`, `tests/fixtures/mock_scripts/name-check.json`, `tests/fixtures/mock_scripts/csv-line.json`, 各3サンプルの `precomputed.json`, このノート。

変更ファイル: `serve.mjs`, `web/app.mjs`, `web/index.html`, `tests/index.mjs`, `README.md`。既存コアとサンプルのコード・差分・手書きテストは変更していません。

## 箱の外での検収（2026-10-24 02:2x JST・検収役）

- 箱の中で飛ばされた手元の通信の試験 6 件を含め、置き場の中から全部を走らせると 69 件が通った。置き場の外から呼ぶと 15 件が落ちた（見本の場所と帳簿の試験の一時フォルダを作業場所から解いていた）。`scripts/mock-flow.mjs` の見本の場所を置き場の根から解くよう直し、帳簿の試験の一時フォルダを OS の一時の場所へ移した。
- 門（staticGate）に、ブラウザの runner が塞いでいる名前（EventSource・Worker・SharedWorker・WebTransport）と、Function へ戻る道の `constructor` を足し、試験を 1 件加えた。門は濾しであって守りの境目ではない（`this['fe'+'tch']` や `fetch` は門を通る）。守りの本体は Worker の中の上書きで、実のブラウザではまだ確かめていない。
- 共通の帳簿を Python（Exception Keeper の FileLedger）と Node（この FileLedger）の両方から同じファイルに読み書きし、合計が合うことを確かめた（ek 0.125＋pw 0.03＝0.155）。
- 結果: 置き場の中と外のどちらからも 70 件が通り、飛ばしは 0 件。模擬の流れの 8 行は検収前と同じ。

## 実のブラウザでの確かめ（2026-10-24 02:3x JST・検収役）

- 見えない Chrome（本人の Chrome とは別の一時の設定）を CDP で動かし、`web/dev-smoke.html` を開いた（道具＝`scripts/browser-smoke-cdp.mjs`）。3 例 × 直し方 2 つの判定は、Node と同じ（good＝supported・incomplete＝patch_suspect）。無限ループは期限 500 ms に対し 506 ms で timeout。
- **穴を 1 つ見つけて塞いだ**: Worker の中で `globalThis.fetch` を上書きしても、Chrome は fetch を `WorkerGlobalScope.prototype` に持つため、`Object.getPrototypeOf(globalThis).fetch.call(globalThis, 絶対 URL)` で通信できた（試しの行が pass で終わった）。塞ぐ名前ごとに、global と、その名前を持つ全部の prototype を上書きするよう `core/runner.browser.mjs` を直した。直した後は 14 の抜け道（直の呼び出し・括弧の呼び出し・ユニコードの書き換え・prototype から・delete の後・XHR・WebSocket・EventSource・入れ子の Worker・動的 import・prototype の postMessage など）がすべて error で終わった。
- 限界: テストは harness と同じ realm で走るので、テストが結果そのものを偽ることは防げない（作るテストはモデルの物で、走るのは利用者自身のブラウザ）。確かめたのは Chrome だけで、Safari と Firefox は未確認。

## Live verification (2026-10-24)

The key arrived on 2026-10-24 and the live checks above were run against Token Factory; the earlier "no key yet" and "unknown until live" notes are historical.
Results, run-to-run spread, the schema-style decision and the limits that changed are in the README section "Recorded live results (2026-10-24)".
The rewrite limit is now three (four test rounds per session; `web/flow.mjs` `MAX_REWRITES` and the API's stage-order check), raised after those recordings.
