# Pi compatibility

Warren supports **Pi 1.4.0** (`@earendil-works/pi-coding-agent`). Both agent-bearing
images and the standalone judge pin that exact version. Historical parser fixtures
remain regression inputs; they do not select a legacy live protocol. See the [validation evidence](pi-1.4.0-validation.md) for the automated and live acceptance results.

## Installation

Local operators need Node **22.19.0 or newer** and the package's declared `pi` CLI
on PATH. Install with `npm install -g @earendil-works/pi-coding-agent@1.4.0` and
verify `node --version` and `pi --version`. Do not rewrite Pi's CLI shebang to Bun.
Warren and the judge service continue to run on Bun. The judge uses Pi's SDK in
its independent package, with no global CLI dependency.

## Credentials

Set `WARREN_PI_AUTH_FILE` on the Warren server process to an absolute path to a
Pi-format `auth.json`. For the standalone judge, set `JUDGE_PI_AUTH_FILE` and
select `JUDGE_PROVIDER` / `JUDGE_MODEL`. These are operator settings, never
repository configuration or agent frontmatter. For containers, mount the source
file read-only outside project directories and use its container path.

Only the selected provider's OAuth entry is copied. Warren places it at
`<private-run-home>/.pi/agent/auth.json`; the judge creates a private temporary
agent directory per attempt. Directories use mode 0700 and files mode 0600 on
Unix. Settings, extensions, prompts and unrelated credentials are not copied.
The SDK may refresh its writable copy. Cleanup removes the copy after execution,
including failed starts; run-home teardown retries a failed driver cleanup.

A matching OAuth entry takes precedence over an ambient API key. A missing
matching entry retains API-key authentication. An unreadable or malformed selected
credential fails clearly. Authentication failure does not switch accounts.
Refreshes are never written back to the operator file: refresh or re-login to the
source with Pi when needed. Keep the source outside agent-writable locations.

OAuth worker runs use `subscription_estimate` as their cost basis. Spend caps
remain estimated-usage brakes, not statements of subscription billing. Accounting
covers the primary session, not arbitrary extensions' subagents or routers.
Kubernetes OAuth provisioning is unsupported in this milestone and explicitly
rejected; use its existing API-key provisioning.

## Runtime contract

The driver keeps stdin open through `agent_end`, automatic retries, compaction
recovery and queued steering. `agent_settled` ends the live run; `aborted` maps to
cancellation. A process exit before settlement fails even when its exit code is
zero. Correlated rejected prompts fail immediately. A `handled` prompt is checked
for idle state so an extension that consumes input without a run can complete.
Additional prompts use `streamingBehavior: "steer"`. Interactive extension
requests are declined automatically.

Streaming spend reads `message_update.usage`; completed `turn_end` usage replaces
the provisional total. Completed retry attempts and `compaction_end.result.usage`
are added once. Final session totals are persisted at settlement. Missing usage
remains distinct from measured zero. Session transcripts remain excluded from Git
delivery, while session metadata is retained.

The judge uses in-memory sessions, a rubric-only system prompt, and exactly its
three custom tools: `get_run_facts`, `page_events`, and `report_verdict`. It disables
discovered project resources, built-in tools, and MCP tools.

## Upgrade procedure

1. Review the target package's RPC docs, SDK types and Node requirement. Update
   both Docker pins and the judge pin together; regenerate only the judge lockfile.
2. Capture a new trace using `WARREN_PI_TEST_CLI=<absolute CLI entrypoint>` and
   `WARREN_PI_CAPTURE_DIR=<temporary directory>` with
   `bun test src/runtime/adapters/pi-binary.test.ts`. This uses a controlled local
   provider and no operator credentials. Review normalized traces before copying
   them into the versioned golden directory.
3. Run focused lifecycle, provenance, usage and credential tests, then
   `bun run check:all --bail`. Run `bun test` inside `extensions/judge` explicitly.
   The extension validation gate also runs the real SDK compatibility tests.
4. Build the control-plane, agent and judge images. Their build checks verify the
   CLI or SDK version; run the real SDK tests inside the judge image as well.
5. Use a disposable Python/TypeScript repository and local Git remote for bounded
   worker, steering, cancellation and judge acceptance. Record the model, versions,
   usage, session id, Git delivery and cleanup evidence. Do not claim compatibility
   from dependency pins alone.
