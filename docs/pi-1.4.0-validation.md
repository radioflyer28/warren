# Pi 1.4.0 compatibility validation

Validated on 2026-10-23 against the Warren fork's base commit
`ce088e854c96492358b6f0a0e26695baf801968d`.

Warren worker runs launch the package's declared `pi` executable with
`--mode rpc`. Commands are JSON lines on stdin; responses and events are JSON
lines on stdout. This is the RPC interface, not an interactive terminal session
or a one-shot text prompt. The optional judge imports the Pi TypeScript SDK
directly and runs on Bun.

See [Pi compatibility](pi-compatibility.md) for installation, credential
provisioning, lifecycle, accounting, limitations, and the upgrade procedure.

## Automated validation

| Check | Result |
| --- | --- |
| `bun run check:all --bail`, Linux | All 12 gates passed |
| Complete repository test sweep | 7,967 passed, 33 skipped, 0 failed; 8,000 tests across 784 files |
| Function coverage | 91.75%, above unchanged 90.91% floor |
| Line coverage | 93.54%, above unchanged 93.37% floor |
| Judge `bun test` | 171 passed, 0 failed |
| Judge tests inside its rebuilt production image | 171 passed, 0 failed |
| Judge real SDK compatibility tests | 5 passed, including actual tool execution, provider failure, OAuth precedence, private refresh and refresh failure |
| Real Pi executable in RPC mode with controlled provider | Passed tool call, live steering, usage, settlement and session persistence checks |
| Session metadata ordering and failure isolation | 2 passed |
| HTTP acceptance scenarios 16, 30, 21 | All passed: Pi lifecycle, Claude cost and Pi environment |
| Control-plane, agent and judge image builds | All passed, including their exact Pi version assertions |

The full gate includes lint, type checking, extension checks, dependency checks,
file/debt/duplication/bundle budgets, generated-document checks, coverage and CI
parity. No quality thresholds or gate manifest were relaxed. The 33 skipped
tests remain skips; this is not a claim that every optional integration ran.

Deterministic tests cover repeated `agent_end` before settlement, successful and
exhausted retries, compaction recovery, queued startup steering, rejected and
handled prompts, exit before settlement, cancellation during generation/tool/
recovery, extension prompt decline, usage replacement and compaction accounting,
credential isolation and cleanup, and the existing Claude lifecycle. Historical
parser fixtures remain unchanged. A versioned fixture was captured from the
actual 1.4.0 executable against a controlled local provider.

CLI images reported Node `22.23.4` and Pi `1.4.0`. The judge image ran Bun
`1.2.23`, resolved SDK `1.4.0`, imported its production session factory and ran
the complete judge suite as its non-root user.

## Bounded live worker and Git delivery

The live test used Linux Docker, the existing OpenAI login and fixed model
`openai/gpt-6.1-sol`. Worker limits were ten minutes and $2 estimated usage.
The fixture was disposable, contained both Python and TypeScript tests, and
used a local bare Git remote. No external pull request was part of this test.

| Evidence | Recorded result |
| --- | --- |
| Worker run | `run_92zsxyx2d6av` |
| Final state | `succeeded`; no failure reason |
| Steering | Sent after the first tool event; added negative-number assertions |
| Task result | Fixed addition in Python and TypeScript and passed both test suites |
| Session ID | `01a16ab0-6dd8-73f2-b1ec-42b1534c49ac` |
| Terminal order | Session metadata at provider sequence 615, then `agent_settled` with `aborted: false` at 616 |
| Usage | 7,439 input tokens, 956 output tokens; $0.0267932 estimated cost |
| Cost basis | `subscription_estimate` |
| Delivered branch | `warren/run_92zsxyx2d6av` |
| Delivered commit | `997af5b859a64e63863e5d494a81c410b20ff15a` |

The harness called Warren's actual spawn, event bridge and reap/finalization
modules. An independent checkout from the pushed branch passed two Python tests
and two Bun/TypeScript tests. Its Git tree contained only the fixture files;
session transcripts and credentials were absent.

## Bounded live judge

The upgraded judge evaluated the worker above using the same model, with one
attempt, no retry, and a $1 estimated usage cap. Its three tools read the actual
persisted run and events through a read-only HTTP facade implementing Warren's
API shapes.

- Verdict: `clean`, confidence `high`.
- One attempt; two event pages read; page cap not reached.
- Estimated cost: $0.0874928.
- Usage: 40,754 input, 162 output, 43,648 cache-read tokens; total 84,564.
- Verdict timestamp: `2026-10-23T21:36:27.312Z`.

The verdict confirmed both fixes, the additive steering request, passing checks,
and the committed/pushed result. The actual judge image and SDK produced the
verdict; a stubbed judge loop was not used as SDK compatibility evidence.

## Cancellation and credentials

A separate run, `run_et7c18d1yrh0`, was cancelled after a long-running bash tool
started. It finished `cancelled` with no failure reason. No worker container
remained, and the disposable acceptance root contained no private `auth.json`
copies after cleanup. Its emitted usage was zero, recorded with
`subscription_estimate`.

Operator credentials were mounted read-only outside agent workspaces. Only the
selected provider's OAuth entry was copied into each private run/attempt home.
The source file was preserved. Real SDK tests additionally verify that a stored
OAuth credential wins over an ambient API key, refresh persists only in the
private copy, and failed refresh raises an error rather than switching accounts.

A focused credential review found no additional actionable issues in the changed
paths: source selection is operator-only, errors omit credential contents,
private copies are removed, and the judge exposes only its three intended tools.

## Environment notes and reproduction

The host is Windows; authoritative gates and acceptance ran in Linux Docker.
The Windows hook attempt failed on UI grit baseline handling, and an earlier
Windows test run hit two existing path-separator assertions. Those Linux checks
passed. Hooks are retained; no bypass is part of this change.

This network requires an additional public CA. Image builds used temporary
Dockerfile overlays that add a BuildKit CA secret to install steps, including
APT's HTTPS CA setting. TLS verification stayed enabled. These environment-only
overlays and the CA are not committed. Ordinary environments can build the
repository Dockerfiles directly.

```sh
bun run check:all --bail
(cd extensions/judge && bun test)
# From the repository root, with the declared Pi CLI installed:
WARREN_PI_TEST_CLI=/usr/local/bin/pi bun test src/runtime/adapters/pi-binary.test.ts
bun run scripts/acceptance/run.ts --only 16,30,21 --stop-on-failure
docker build -t warren-pi14-control .
docker build -t warren-pi14-agent -f deploy/docker/Dockerfile.agent .
docker build -t warren-pi14-judge extensions/judge
docker run --rm --entrypoint bun warren-pi14-judge test
```

Raw local validation logs, controlled/live harnesses, and disposable fixture
evidence were retained in the implementation session's `work/` directory.
This milestone covers primary-session accounting and local/Docker OAuth.
Kubernetes retains API-key provisioning; third-party subagent/router accounting
and the deferred software-factory features are outside this acceptance claim.
