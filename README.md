# FlipWitness

FlipWitness turns a bug report and a patch into evidence. NVIDIA Nemotron writes the
tests, your browser runs them on the original and the patched code, and only a test that
fails before and passes after counts as a **witness**. With no witness, the model rewrites
the tests from the before/after results, up to three times.

- **Live demo:** https://flipwitness.vercel.app/
- **Video (under 3 minutes):** _added at upload_
- **Track:** Coding and Agentic Engineering · Nebius x NVIDIA Global AI Hackathon

The default sample view shows recorded live runs (NVIDIA Nemotron 3 via Nebius Token
Factory, 2026-10-24) and makes no model calls. "Run live" and the paste mode call the
models. The samples are self-written fictional modules. There are no dependencies,
downloads or build steps.

## How NVIDIA Nemotron and Nebius Token Factory are used

All model calls go to the Nebius Token Factory OpenAI-compatible API
(`https://api.tokenfactory.nebius.com/v1/`) at runtime, with structured JSON output.
Generated tests never run on the server.

| Stage | Model | What it does | Calls per session |
|---|---|---|---|
| Extract | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | Expected and actual behaviour, reproduction steps and inputs from the bug report. | 1 |
| Hypothesise | `nvidia/Nemotron-3-Ultra-550b-a55b` | One to three root-cause hypotheses tied to real files, with edge cases to test. | 1 |
| Write tests | `nvidia/nemotron-3-super-120b-a12b` | Candidate tests for a small harness; on a rewrite it sees which tests passed on both sides or failed after the patch. | 1 to 4 |
| Run | none (your browser) | A Web Worker runs each test on the original and the patched code. Network APIs, nested workers and dynamic imports are disabled; a looping run stops after 1.5 s. | 0 |
| Classify | none (code) | witness / passes both / fails after / inconclusive, and the card: supported, patch suspect or no evidence. | 0 |

Token Factory made the three-size design cheap to build: one endpoint and key, a
model-ID change between stages, rate-limit headers and per-model prices that feed the
app's spending ledger. A full session cost $0.005–$0.023.

## Run it locally

Node.js 22, no `npm install`.

```sh
node --test tests/
node cli.mjs samples/month-end --patch good --tests golden
node cli.mjs samples/month-end --patch incomplete --tests existing
node scripts/mock-flow.mjs
node serve.mjs
```

To preview, run `node serve.mjs`, then open `http://127.0.0.1:4173/`. The samples work without a key.
To call the models live locally, set `NEBIUS_API_KEY`, `PW_LIVE=1` and `PW_GRANTED_CREDITS_USD`
(your granted credit) in the environment first; spending is recorded in `~/.x129/ledger.jsonl`
unless `X129_LEDGER_PATH` points elsewhere.
The root redirects to `/web/index.html`. The server also provides the local POST `/api/pw` endpoint. Stop the server with Ctrl-C. The page requires HTTP serving from
the project root; opening the HTML as a local file is not the supported workflow.

Samples: `month-end`, `name-check`, `csv-line`. CLI patch choices: `good`,
`incomplete`. Test choices: `golden`, `existing`. The CLI exits with code 0 when
tests fail or are inconclusive (those are evidence-card results) and with code 1
for invalid arguments, missing files or a patch that does not apply.

## Deploy on Vercel

The repository deploys as-is on Vercel (no build step). Static files are served from the
project root (`/` redirects to `/web/index.html`), and `api/pw.mjs` is the Vercel Function
for `POST /api/pw` (a `POST(request)` export, `maxDuration` 120 s in `vercel.json`).

Live calls need a shared, durable spending ledger because function instances share no files:
connect an Upstash Redis database from the Vercel Marketplace to the project. The function
reads `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL` /
`KV_REST_API_TOKEN`). Then set `NEBIUS_API_KEY`, `PW_LIVE=1` and `PW_GRANTED_CREDITS_USD`
(the credit actually granted, shared with the sister app). On Vercel, live stays disabled
unless the Redis ledger is configured; the recorded samples always work at $0.

## API

```js
import { applyUnifiedDiff } from './core/patch.mjs';
import { runSuite } from './core/runner.mjs';
import { buildEvidenceCard } from './core/evidence.mjs';

const moduleFiles = { 'src/example.mjs': 'export const value = 1;' };
const testSource = `
  import { value } from '@entry';
  import { test, expect } from '@patchwitness/harness';
  test('value is two', async () => {
    await Promise.resolve();
    expect(value).toBe(2);
  });
`;
const patched = applyUnifiedDiff(moduleFiles, diffText);
const options = { entry: 'src/example.mjs', testSource, timeoutMs: 1000 };
const before = await runSuite({ ...options, moduleFiles });
const after = await runSuite({ ...options, moduleFiles: patched });
const card = buildEvidenceCard(before, after);
```

`diffText` in this example must be supplied by the caller. Tests can import the
entry through `@entry` or a relative path from the virtual project root. Supplied
modules may import each other with relative paths. The reserved import
`@patchwitness/harness` provides `test` and `expect`; those two functions are also
available as globals. Module file keys must be canonical relative paths.

Each run has a fresh registry. Duplicate names and the reserved name `[suite]` are rejected. Matchers are
`toBe`, `toEqual` (plain objects, arrays, Dates), synchronous `toThrow` and
`toBeCloseTo(expected, digits = 2)`. Async test functions are awaited. The Node
context deliberately omits timers; use promises without host APIs. A thrown
harness assertion is `fail`; other exceptions are `error`. A suite deadline
includes module setup and all tests; tests not reached by the deadline are
reported as `timeout` with an explanatory message. Setup problems use the name
`[suite]`. `timeoutMs` defaults to 1000 and must be between 1 and 30000.

Classification is conservative: before assertion failure plus after pass is
`witness`; pass/pass is `passes_both`; any after assertion failure is
`fails_after`; runtime errors and timeouts are `errors`. The classifier also
accepts an input error explicitly prefixed `AssertionError:` as an assertion
failure before the patch. The runner itself always emits assertions as `fail`.
The evidence verdict prioritises `patch_suspect` for any `fails_after`, then
`supported` for at least one witness, otherwise `no_evidence`. Inspect the error
count too: `supported` describes a witness and does not certify every test ran.

## Isolation and scope

This sandbox is **not a security boundary for hostile code**. Use trusted,
small modules and candidate tests. Do not run arbitrary untrusted submissions
on a machine holding secrets.

Our Node adapter creates a worker thread containing a fresh `vm` context. The
context receives no `process`, `require`, filesystem or network objects, rejects
external/dynamic imports and disables string/wasm code generation. The parent
terminates the worker on the suite deadline. The worker has small heap and stack
limits; these are operational limits, not protection against every memory or
runtime attack. The worker's trusted controller reads only our harness file.

Our browser adapter creates a dedicated worker from a Blob URL, generates module
Blob URLs from supplied strings, and overrides `fetch`, `XMLHttpRequest`,
`WebSocket`, `importScripts` and additional worker/network constructors to throw.
Its scanner rejects external/dynamic imports. This is a convenience restriction,
not complete control of browser capabilities. The parent loads the trusted
harness from the same project before starting the worker deadline. That initial
asset request is outside `timeoutMs`.

The browser adapter supports the samples' static imports and reexports, and
acyclic module graphs. Its small scanner is not a full JavaScript parser:
interpolated template literals, escaped specifiers, `import.meta` and circular
imports are rejected; regex literals containing quote characters or import-like
tokens can be rejected or misread. Use straightforward sample-style JavaScript.
Node uses native module linking and does not share those scanner restrictions.
Before/after results are paired by unique test name; a test missing from one run
is an error, never a witness. The reviewer checked browser execution in headless
Chrome on 2026-10-24; see the reviewer section of [MODEL_STAGE_NOTES.md](MODEL_STAGE_NOTES.md).
Safari and Firefox remain unchecked. The Order 06 redesign was not viewed in a browser during implementation.

Exact text patches support multiple files/hunks, creation/deletion, newline
markers and CRLF preservation. They reject fuzzy matches, renames, binary diffs,
quoted/escaped Git paths and metadata-only patches. Source contents are strings;
patch application does not write to disk. CSV samples handle a single valid
line, not multiline records or full malformed-input validation. Billing samples
assume valid ISO calendar dates in the modern date range.

## Runtime evidence and references

Local runtime source `node --version` returned `v22.22.3`. Local `node --help`
describes `--experimental-vm-modules` as “experimental ES Module support in vm
module”. Our adapter supplies that flag to its worker; the caller does not need
to pass it. Runtime claims above describe this implementation and are checked by
[`tests/runner.test.mjs`](tests/runner.test.mjs), rather than a security guarantee.
API reference links (not fetched during this offline order):
[Node vm](https://nodejs.org/docs/latest-v22.x/api/vm.html),
[Node worker threads](https://nodejs.org/docs/latest-v22.x/api/worker_threads.html),
[Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API).
See [CORE_NOTES.md](CORE_NOTES.md) for measured results. Licensed under the
[Apache License 2.0](LICENSE).

## Model stage

See [MODEL_STAGE_NOTES.md](MODEL_STAGE_NOTES.md) for the API contract, limits,
shared-ledger caveat, provided API/catalog sources, verified scope, and a maximum
six-call first-live checklist. Samples show recorded live results at cost $0;
“Run live” uses the server API. Paste mode accepts a small multi-file module,
report and unified diff. Generated tests run only in browser Web Workers.

Live calls are disabled unless `PW_LIVE=1`. A positive cumulative granted-credit
ceiling `PW_GRANTED_CREDITS_USD` must also be configured. The key is read at call
time from `NEBIUS_API_KEY`. Optional judging access reads `PW_JUDGE_PASSPHRASE`.
Use `PW_BASE_URL` to override the provided Token Factory URL and `PW_SCHEMA_STYLE`
to select `openai`, `nebius_doc`, `json_object`, or `none`. The live JSONL ledger is
`X129_LEDGER_PATH`, otherwise `~/.x129/ledger.jsonl`. Never enable live calls until
credit-only provider billing is confirmed; the application cannot verify the
provider's cash-billing settings.

`node scripts/live-flow.mjs <log.json>` records live runs into `samples/<name>/precomputed.json`
(only when both patches finish). `node scripts/mock-flow.mjs --write` regenerates the scripted
fixtures in `tests/fixtures/precomputed_mock/`, which the regression tests use. Local socket
tests skip only if their actual loopback bind fails. Serverless deployment remains unverified.

### Recorded live results (2026-10-24)

The same code was run repeatedly per case. Expected: the good patch is `supported` and the
incomplete patch is `patch_suspect`. A recording run moves on only after both patches of a
sample finish, so a stop also skips that sample's other patch. These recordings allowed two
rewrites; the limit was raised to three afterwards (2026-10-24), so a live run can now try
one more round before reporting no evidence.

| Sample | Good patch | Incomplete patch |
|---|---|---|
| month-end | supported 3 of 3 | patch_suspect 2 of 3 (1 stopped) |
| name-check | supported 1 of 2 (1 no_evidence) | patch_suspect 2 of 2 |
| csv-line | supported 0 of 7 (patch_suspect 3, no_evidence 1, stopped 3) | patch_suspect 1 of 4 (3 stopped) |

**The shipped files are selected runs, not typical runs**: for each sample, the complete
run that matched the most expectations (re-runs replaced a file only when they matched more) (month-end and name-check: both patches as expected;
csv-line: the incomplete patch only, from the first run). The files are unedited. In the
shipped csv-line/good the generated tests found three witnesses, but three other tests
expected wrong values and failed after the patch; by the product rule any failure after the
patch makes it suspect, and the evidence table shows which tests and why. "Stopped" means the
model's tests failed validation twice in one rewrite round. csv-line is the hard case: its
inputs are full of double quotes (see the first limitation), and one probe spent 5,603
reasoning tokens and 54.5 s on a single test-writing call, then dropped a closing
parenthesis. Each session cost $0.005–$0.023. Known limitations:

- Answers vary between runs; a witness is evidence for those tests only.
- With reasoning on, strict `json_schema` answers never contained a newline, a double
  quote or a backslash inside `tests_source` (10 of 10 recorded). The tests prompt therefore
  asks for single quotes, `String.fromCharCode(34)` for a double quote, and no comments.
- Nemotron reasoning counts against `max_tokens` (Nano reports it only in a separate
  `reasoning` field); stage limits are 3,000 / 6,000 / 8,000 tokens.
- Single calls took 2.6–30.5 s. The live adapter allows 55 s per call; the serverless
  function limit must be checked at deploy.


## Web workspace

The page starts with recorded live sample results at $0. Select a sample card and a
good or incomplete patch to inspect the report, code, model stages, generation
rounds and evidence table. The displayed model IDs and costs are from the recorded run. “Run golden tests” executes hand-written tests locally; “Run live”
calls the API. The separate “Paste your code” tab uses live generation.

The interface uses system fonts, inline styles and local ES modules only. It has
light/dark palettes, keyboard-operable tabs and sample/patch choices, and
scrollable code and result regions. No dependencies or build step were added.

For reviewer browser checks, open `/web/dev-smoke.html` on the preview server.
Alongside the existing runner/isolation probes, `render/<sample>/<patch>` reports
the verdict shown, whether the evidence table rendered, its row count and whether
those values match the sample file. This uses the same renderer as the app and makes
no live model calls. Probe URLs come from the page's own origin. An expandable
preview shows the last sample rendered. The Node rendering tests use a small
element test double; they do not verify browser layout or accessibility behavior.

## License

[Apache License 2.0](LICENSE).
