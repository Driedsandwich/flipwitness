# FlipWitness model stage — Order 04

audience: maintainers

Implemented the 3 model stages, budget ledger, API, and UI integration. Calls to real models and spending are 0. Verification covers mocks, HTTP response substitution without communication, and the Node runner. Stub tests using real sockets are implemented, but 6 were skipped because listening was denied with `EPERM` in this environment. No real-model quality has been demonstrated at all.

**Design and reproduction.** No dependencies were added and no build is required. The following commands do not communicate externally.

```sh
node --test tests/
node scripts/mock-flow.mjs
node scripts/mock-flow.mjs --write
```

The last command regenerates `precomputed.json` for the 3 samples. Each file has `"source": "mock"` and `"cost": 0` at the top level. The internal session costs are example calculations using fictitious `usage`. In the CLI, `cost` is actual spending, and `simulated_usd` is the cumulative total of those example calculations. Round 0 is the initial attempt; 1 and 2 are rewrites. The name-validation sample includes a response containing `fetch` to verify rejection before execution and repair.

`server/models.mjs` holds the supplied model IDs and prices. `llm.mjs` provides `complete({model, messages, responseFormat, maxTokens, temperature})`. The HTTP implementation reads the key from the environment at call time and, by default, retries only 429 and 5xx responses up to 2 times. It sets a shared 8-second cutoff across all attempts and fails without waiting if `Retry-After` exceeds the remaining time. It handles numeric seconds and HTTP dates. Communication exceptions and provider error bodies are not exposed. These branches are verified by substituting `fetchImpl` without communication.

The output format in `jsonout.mjs` is switched using only `PW_SCHEMA_STYLE`. Its values are `openai` (default), `nebius_doc`, `json_object`, and `none`. It removes `think` elements from JSON and accepts a JSON fence or the first balanced object. It does not use the separate `reasoning_content` field. It checks types, required fields, enum values, character counts, array item counts, and additional properties. If JSON, schema, or static-gate checks fail, it makes one repair attempt with only the reason attached. Each stage allows a total of at most 2 responses; after that, the result is `upstream_error`.

`stages.mjs` assigns extraction to Nano, hypotheses to Ultra, and test generation to Super. Hypotheses about nonexistent files are removed. Tests can import only from `@entry` and `@patchwitness/harness`. The entry file name is also passed to the prompt. Before execution, it checks the 8 KiB limit, forbidden words, import targets, and the presence of `test(`. **The static gate is a filter, not a security boundary.** It is a conservative check that also reacts to forbidden words inside strings and comments. It also inherits the syntax restrictions of the existing browser import scanner. See [CORE_NOTES.md](CORE_NOTES.md) for details.

`web/flow.mjs` calls extraction, hypothesis generation, and test generation in order and pairs the before-and-after results. If there is no evidence, it sends the results back for up to 2 rewrites. If there is evidence, it stops even with `patch_suspect`. The UI delegates execution only to the dedicated Web Worker in `runner.browser.mjs`. The server API executes neither submitted code nor generated tests. Only the CLI and tests inject the existing Node runner.

The UI displays precomputed sample results at a cost of 0. For samples, “Generate tests with Nemotron” displays precomputed results, while the separate “Run live” calls the API. In paste mode, the user enters a JSON object of file names and source code, the entry point, report, and diff to use the API. The UI displays all test results and generated source for each round, model IDs, costs, and a link to precomputed results when the budget check rejects a call. It also displays the specified sharing notice.

**Budget and permissions.** `PW_LIVE` is disabled by default. Enabling live mode requires `PW_LIVE=1` and a positive `PW_GRANTED_CREDITS_USD`. The latter is the total granted credits for both apps combined, not the remaining balance. The key is read only from `NEBIUS_API_KEY`, and the optional judging passphrase only from `PW_JUDGE_PASSPHRASE`. Keys and passphrases are not stored in arguments, logs, the ledger, or error bodies. Passphrases are compared using `timingSafeEqual` on fixed-length digests; a mismatch uses public. The server issues session IDs and also checks stage order, lane consistency, and the maximum of 3 test-generation rounds against the ledger.

The limits are $0.08 per session in total; for pw's development period of 2026-10-23〜10-30, $5.00 in total; for 2026-10-31〜11-30, a 1-day limit of $0.10; and for 2026-12-01〜12-16, a 1-day limit of $0.40 for judge and a 1-day limit of $0.15 for public. Dates use Asia/Tokyo. Calls are not allowed outside these periods. The smaller of $45.00 across all periods and both apps combined and the configured granted-credit amount also applies. Limits specific to ek are not enforced.

Immediately before each call, cost is estimated from the input token count, calculated by rounding up the prompt's character count ÷3, and the maximum output token count. Admission checks also account for the allowed number of HTTP retries. Successful calls are calculated using `usage.prompt_tokens` and `usage.completion_tokens`. If `prompt_tokens_details.cached_tokens` is a valid integer, the cache discount from the supplied prices is applied. Whether the real service returns this field is unverified. If usage is absent, the output character count ÷3 is also used, and `estimated: true` is recorded in the ledger. The API also returns `cost_estimated`. Since billing for failed attempts is unknown, the admission estimate for that attempt is conservatively recorded. JSON repair is also checked against the limits as a separate call.

The ledger is at `$X129_LEDGER_PATH`, or `~/.x129/ledger.jsonl` if unset. Existing rows must use the following format.

```json
{"app":"pw","lane":"public","day":"2026-10-24","amount":0.0001,"session":"server-generated-id","stage":"extract","estimated":false}
```

`app` is pw or ek, `lane` is public or judge, `day` is a valid date, and `amount` is a finite, nonnegative USD value. Extra fields are allowed. Stage starts and completions are rows in the same format with an amount of 0. Any invalid JSON, blank line, or invalid required value causes calls to be rejected. Amounts are floating-point USD values.

The Node implementation acquires an adjacent `.lock` by exclusive creation and holds it from the admission check through recording the response. The wait limit is 1 second, and the stale-lock timeout is 120 seconds. **Python's `fcntl.flock` and this lock file do not provide mutual exclusion with each other. Concurrent use of both apps on the same machine is not serialized.** A shared transactional store or a common locking method is required before concurrent live use. Complete recovery of billing records after forced process termination is not guaranteed either. Do not reuse incomplete sessions; reconcile them with the provider's usage records.

The app cannot verify the provider's credit balance or cash-billing settings. Token estimates based on character counts are not strict upper bounds either. **The $0 out-of-pocket requirement must also be ensured through the provider's actual billing settings.** Do not enable `PW_LIVE` until it is confirmed that usage can consume only granted credits and will not trigger automatic cash payments or charges for shortfalls. Whether such settings exist is unverified. This order was completed with live mode still disabled and actual spending of 0.

`api.mjs` is an HTTP-independent `handle(requestJson, env, deps)`. The limits are 64,000 bytes for the entire input, 4,000 characters for the report, 12,000 bytes for all source code combined, and 16,000 bytes for the diff. There are at most 20 files. It returns the stage JSON and `session`, `model`, `rateHeaders`, `cost`, `cost_estimated`, and `remaining_session_usd`. Rejection codes are `budget`, `too_large`, `bad_request`, and `upstream_error`. Results provided for rewrites are limited to 50 items, with each message limited to 1,000 characters.

`serve.mjs` is a thin adapter for 127.0.0.1. It serves only public files in web/core/samples, not server internals or the ledger. `server/serverless.mjs` is a generic Web Request/Response adapter. **unverified until deploy**. No support for a specific platform is claimed. The deployment target's Node capabilities, shared ledger, and persistence must be verified, and the JSONL implementation must be replaced with a shared, persistent transactional store.

**Sources and unverified items.** The following were supplied for Order 04 as snapshots of official documentation dated 2026-10-24. No external sites were retrieved during this work.

- The supplied endpoint and authentication values are `https://api.tokenfactory.nebius.com/v1/`, `chat/completions`, and `Authorization: Bearer <key>`. [Token Factory quickstart](https://docs.tokenfactory.nebius.com/quickstart.md)
- The supplied model IDs and USD prices per 1M tokens in the table below were used unchanged. [Official model catalog](https://tokenfactory.nebius.com/model-catalog.md)

| Role | Model ID | Input USD / 1M | Cached input USD / 1M | Output USD / 1M |
| --- | --- | ---: | ---: | ---: |
| Nano | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 0.06 | Not supplied | 0.24 |
| Super | `nvidia/nemotron-3-super-120b-a12b` | 0.30 | 0.06 | 0.90 |
| Ultra | `nvidia/Nemotron-3-Ultra-550b-a55b` | 1.00 | 0.12 | 3.00 |

- The supplied structured-output values are `"type": "json_schema"` or `"type": "json_object"`. It is unknown whether the direct schema in the documentation example or the OpenAI-format wrapper is accepted, or whether each Nemotron 3 supports them. The default openai is an assumption for compatibility testing. [Structured output documentation](https://docs.tokenfactory.nebius.com/ai-models-inference/json.md)
- Exceeding a limit produces `HTTP 429`; the supplied header names are `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`, and `x-ratelimit-over-limit`. Actual values and limits have not been measured. [Rate limit documentation](https://docs.tokenfactory.nebius.com/ai-models-inference/rate-limits.md)
- The reasoning output format, actual token counts, cache usage fields, and quality of model-generated tests are also unverified.

References for standard APIs are [Node fetch](https://nodejs.org/docs/latest-v22.x/api/globals.html#fetch), [AbortSignal.timeout](https://nodejs.org/docs/latest-v22.x/api/globals.html#static-method-abortsignaltimeoutdelay), [Filesystem](https://nodejs.org/docs/latest-v22.x/api/fs.html), and [timingSafeEqual](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptotimingsafeequala-b). These pages have not been retrieved. The basis for API use here is verification through local execution. For the existing core's Node execution flag, see the local `node --help` quotation in [CORE_NOTES.md](CORE_NOTES.md).

**Initial live checklist (not performed, at most 6 calls).** Prerequisites are the credits-only billing confirmation described above, a date within the allowed periods, mutual exclusion for the shared ledger, and key configuration authorized by the owner. Use only the small month-end sample. Set `maxRetries: 0` on the HTTP client and disable JSON repair and test rewrites. Instead of using the normal `runStage` or the UI, call the budget-wrapped `complete` 1 time at a time and inspect responses with `parseJSON` / `validate`. Do not add repair calls after failures. Do not record sensitive information or reasoning; record only model IDs, format, success or failure, usage, cost, and the 3 rate-limit headers.

1. Nano, `nebius_doc`, maximum output of 256 tokens. Specify the extraction schema for a short report directly.
2. Nano, `openai`, the same report and schema, maximum output of 256 tokens. Compare acceptance of the wrapper format.
3. Nano, `json_object`, the same report and prompt, maximum output of 256 tokens. Validate locally.
4. Nano, `none`, the same report and prompt, maximum output of 256 tokens. Verify JSON output without a format specification.
5. Ultra, an accepted format, maximum output of 512 tokens. Request 1 hypothesis from the small month-end source and good diff, and check the file name and explanation. If no format is accepted, stop the remaining steps.
6. Super, an accepted format, maximum output of 768 tokens. Statically check candidate tests and observe before-and-after execution in the browser. Do not make additional model calls.

With estimated input limited to at most 1,800 tokens per call, the total estimate without cache discounts is $0.005245. The guideline is below $0.006 and below the requested cap of $0.05. Record actual costs using usage, and stop at the admission check if the remaining balance is insufficient. These are not measured prices or token counts.

**Verification results.** The existing 29 tests are preserved. Added tests cover the mock flow, all forbidden words, repair counts, ledger persistence, stale locks, concurrent calls, JST boundaries, each limit, API input, lanes, non-exposure of secrets, and Node/Web adapters. Browser UI operation and Web Worker execution in a real browser have not yet been observed. Deployment, Tavily, and the license text are not included in this change.

The 6 skipped tests are real-HTTP verification of all 4 formats, real-HTTP verification of 429 and 4xx responses, real-HTTP verification of 500 responses and long Retry-After values, real-HTTP repair of invalid JSON, the full real-HTTP flow for the good month-end patch, and the full real-HTTP flow for the incomplete month-end patch. All are skipped only when an actual `listen(0, '127.0.0.1')` fails. Passing substitution tests without communication does not count as passing real-socket tests.

The final test output is recorded below.

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

`node --check` for 15 modules and checks of fixed ID references in the UI also passed. This does not verify UI rendering, interaction, or Worker execution.

This table corresponds to the measured output of `node scripts/mock-flow.mjs`. Costs are actual spending in USD. The initial attempt is round 0.

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

New files: `server/models.mjs`, `server/llm.mjs`, `server/jsonout.mjs`, `server/stages.mjs`, `server/budget.mjs`, `server/api.mjs`, `server/runtime.mjs`, `server/serverless.mjs`, `web/flow.mjs`, `scripts/mock-flow.mjs`, `tests/model-stage.test.mjs`, `tests/budget-api.test.mjs`, `tests/fixtures/mock_scripts/month-end.json`, `tests/fixtures/mock_scripts/name-check.json`, `tests/fixtures/mock_scripts/csv-line.json`, `precomputed.json` for each of the 3 samples, and this note.

Changed files: `serve.mjs`, `web/app.mjs`, `web/index.html`, `tests/index.mjs`, `README.md`. The existing core and sample code, diffs, and handwritten tests have not been changed.

## Acceptance checks outside the sandbox (2026-10-24 02:2x JST · the reviewer)

- Including the 6 local communication tests skipped inside the sandbox, running the full suite from inside the repository passed 69 tests. Calling it from outside the repository failed 15 tests (sample paths and temporary directories for ledger tests were resolved relative to the working directory). Fixed `scripts/mock-flow.mjs` to resolve sample paths from the repository root, and moved temporary directories for ledger tests to the OS temporary location.
- Added the names blocked by the browser runner (EventSource, Worker, SharedWorker, WebTransport) and `constructor`, a path back to Function, to the gate (staticGate), and added 1 test. The gate is a filter, not a security boundary (`this['fe'+'tch']` and `fetch` pass through the gate). The actual protection is the overrides inside the Worker, which had not yet been checked in a real browser.
- Read and wrote the shared ledger in the same file from both Python (Exception Keeper's FileLedger) and Node (this FileLedger), and confirmed that the total matched (ek 0.125＋pw 0.03＝0.155).
- Results: 70 tests passed from both inside and outside the repository, with 0 skipped. The 8 rows of the mock flow were unchanged from before acceptance checks.

## Verification in a real browser (2026-10-24 02:3x JST · the reviewer)

- Ran headless Chrome (with a temporary profile separate from the owner's Chrome) through CDP and opened `web/dev-smoke.html` (tool＝`scripts/browser-smoke-cdp.mjs`). Verdicts for 3 examples × 2 patch types matched Node (good＝supported, incomplete＝patch_suspect). With a 500 ms deadline, an infinite loop timed out at 506 ms.
- **Found and closed 1 hole**: Even after overriding `globalThis.fetch` inside the Worker, Chrome has fetch on `WorkerGlobalScope.prototype`, so communication was possible through `Object.getPrototypeOf(globalThis).fetch.call(globalThis, absolute URL)` (the probe row ended with pass). Updated `core/runner.browser.mjs` to override the global and all prototypes containing each blocked name. After the fix, all 14 bypass paths (direct calls, bracket-notation calls, Unicode rewrites, access through prototypes, access after delete, XHR, WebSocket, EventSource, nested Workers, dynamic import, prototype postMessage, and others) ended with error.
- Limitations: Tests run in the same realm as the harness, so tests cannot be prevented from falsifying the results themselves (the generated tests come from the model and run in the user's own browser). Only Chrome was checked; Safari and Firefox are unverified.

## Live verification (2026-10-24)

The key arrived on 2026-10-24 and the live checks above were run against Token Factory; the earlier "no key yet" and "unknown until live" notes are historical.
Results, run-to-run spread, the schema-style decision and the limits that changed are in the README section "Recorded live results (2026-10-24)".
The rewrite limit is now three (four test rounds per session; `web/flow.mjs` `MAX_REWRITES` and the API's stage-order check), raised after those recordings.
