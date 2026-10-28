# PatchWitness deterministic core

audience: maintainers

Implemented without adding dependencies, downloading anything, or calling Web APIs. Node execution and CLI verdicts have been checked. Browser execution and visual checks have not been performed.

## Structure and decisions

- `core/patch.mjs`: Applies a unified diff to copies of file contents. Checks original line numbers, output line numbers, line counts, context, and the presence or absence of newlines. Handles multiple files and hunks, creation and deletion, and CRLF. Mismatches raise exceptions with the file name and hunk number. Does not write to disk.
- `core/harness.mjs`: Provides `test`, `expect`, and 4 kinds of assertions. Awaits asynchronous tests in order. Assertion failures are `fail`; other exceptions are `error`. Rejects duplicate names and the reserved name `[suite]`.
- `core/runner.mjs`: Selects the execution target using the same argument format. `runner.shared.mjs` shares path resolution, argument validation, deadlines, and result collection.
- `core/runner.node.mjs` and `runner.node.worker.mjs`: Create a new `vm` context in a dedicated thread. The caller terminates the thread after the deadline, so both synchronous infinite loops and Promises that never complete can be stopped. Preserves completed results and also marks tests that have not run as `timeout`, with a reason.
- `core/runner.browser.mjs` and `runner.browser.imports.mjs`: Create a dedicated Web Worker from a Blob URL. Rewrite static imports in the supplied modules to internal Blob URLs. Replace `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, and similar facilities in the Worker with exceptions. The caller terminates the Worker after the deadline and releases the Blob URLs.
- `core/classify.mjs`: Classifies an assertion failure in the original code followed by a pass after the patch as a `witness`. Runtime errors and timeouts do not count as evidence. For compatibility, original-code results explicitly starting with `AssertionError:` and marked `error` are also accepted as assertion failures.
- `core/evidence.mjs`: Pairs before-and-after results by test name and preserves statuses and messages. Missing results are `error`. The verdict is `patch_suspect` if there are assertion failures after the patch; otherwise, it is `supported` if there is evidence, and `no_evidence` if there is none.
- `samples/`: Contains 3 examples: month-end billing dates, names containing only whitespace, and commas inside quotation marks. Each example has original code, existing tests, a bug report, 2 kinds of patches, handwritten reproduction tests, and a `sample.json` for loading.
- `cli.mjs`: Outputs evidence-card JSON. Normal completion returns 0 regardless of whether tests pass or fail. Returns 1 only when the tool's own processing fails, such as a problem with arguments, files, or diffs.
- `web/`: Implements sample selection, display of code, reports, and diffs, execution of handwritten tests, and display of before-and-after results. The LLM button is disabled with the specified explanatory text. `serve.mjs` is optional for local viewing and does not open a browser automatically.

## Scope and limitations of isolation

**This is not a security boundary against hostile code.** The design is limited to small, trusted code and tests.

On the Node side, `process`, `require`, filesystem objects, and networking objects are not passed to the target context. External and dynamic imports are rejected, and code generation from strings and WebAssembly is disabled. Timer APIs are not passed in either. The assertions themselves run inside the target context. Only the host-side controller reads this project's files used for checking. Thread heap and stack limits are operational limits, not a guarantee against all memory exhaustion or runtime attacks.

The browser-side rewriter is not a complete JavaScript parser. It rejects circular imports, template strings with interpolation, module specifiers containing escapes, and `import.meta`. It may mishandle regular expression literals containing quotation marks or words resembling imports. It targets simple static modules in the sample format. Complete containment of browser capabilities is not guaranteed. The caller's loading of trusted files used for checking is outside the Worker's deadline measurement.

The deadline applies to the entire run, including startup and module evaluation, rather than to 1 test at a time. Syntax, linking, and registration failures use `[suite]`. Exceptions other than assertion failures, along with timeouts, are counted in `errors`. Even with `supported`, other tests may have errors, so the UI and consumers also need to check the counts and messages.

Fuzzy diff matching, renames, binary diffs, Git-format paths using quotation marks or escapes, and metadata-only diffs are not supported. CSV handling targets valid single lines; multiline records and complete validation of malformed input are out of scope. The billing-date example assumes valid ISO dates in a modern date range. Since the accuracy of the Apache-2.0 text could not be guaranteed, `LICENSE_TODO.md` was created as specified.

## Measured results

The local output of `node --version` was `v22.22.3`. As primary documentation for the runtime, `node --help` from the same executable contains the following:

```text
--experimental-vm-modules   experimental ES Module support in vm
                            module
```

Source: `node --help` in the working environment. The Node adapter passes this flag to the dedicated thread. No external documentation was retrieved. References for the relevant APIs are listed in [README.md](README.md).

The final `node --test tests/` exited with code 0. The end of its output is reproduced below.

```text
1..29
# tests 29
# suites 0
# pass 29
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1134.415459
```

In this run, with a 200 ms deadline, the entire infinite-loop test took 203.114 ms and the entire unresolved-Promise test took 202.847208 ms. With a 150 ms deadline, an infinite loop during module evaluation took 152.464333 ms. These figures include execution and termination processing time. Tests attempting direct access to `process`, `require('fs')`, `fetch`, and similar facilities all returned `error`. No network communication took place.

For each row in the table below, the CLI ran `--tests golden` and `--tests existing` in separate processes. All 12 runs exited with code 0. The evidence counts and post-patch failure counts refer to handwritten tests.

| Sample | `--patch` | `--tests golden` verdict | Evidence count | Post-patch failure count | `--tests existing` verdict |
| --- | --- | --- | ---: | ---: | --- |
| month-end | good | supported | 3 | 0 | no_evidence |
| month-end | incomplete | patch_suspect | 2 | 1 | no_evidence |
| name-check | good | supported | 2 | 0 | no_evidence |
| name-check | incomplete | patch_suspect | 1 | 1 | no_evidence |
| csv-line | good | supported | 3 | 0 | no_evidence |
| csv-line | incomplete | patch_suspect | 2 | 1 | no_evidence |

There are 2 existing tests for the month-end example and 3 each for the name and CSV examples. All were `passes_both` with both patches. Each example has 3 handwritten tests. Across all 12 runs, `errors` was 0.

As an additional static check, `node --check` passed for 30 ES modules. For the 3 examples, the original code, good patches, incomplete patches, and handwritten tests totaled 21 module variants; browser import rewriting and syntax checks passed for all of them. These checks do not demonstrate Worker execution in a browser. The preview server was not started either.
