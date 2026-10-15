# Vendor CLIs: recorded behavior

Recorded 2026-10-14 on macOS from real runs. Fixtures live in `fixtures/<vendor>/`. Files named `*ratelimit*` are **synthetic**: they follow the recorded schemas, because a real limit can't be triggered on demand. Every other fixture is real output with paths and emails scrubbed.

| | Claude Code | Codex | Cursor agent |
|---|---|---|---|
| Version | 2.1.285 | codex-cli 0.162.1 | 2026.10.14-0f9edde |
| Binary | `claude` | `codex` | `cursor-agent` (`agent` alias not installed here) |
| Headless | `claude -p <prompt> --output-format stream-json --verbose` | `codex exec --json <prompt>` (stdin must be closed, or it waits: "Reading additional input from stdin...") | `cursor-agent -p <prompt> --output-format stream-json --trust` (stdin closed) |
| Write mode | `--permission-mode acceptEdits --allowedTools Write,Edit,Read,Bash,...` | `-s workspace-write` (first run); on resume `-c sandbox_mode="workspace-write"` (resume has no `-s`) | `--force` |
| Read-only | `--permission-mode plan` | `-s read-only` / `-c sandbox_mode="read-only"` | `--mode plan` (or `ask`) |
| Model | `--model <id>` | `-m <id>` | `--model <id>` |
| Resume | `--resume <session-id>`: same session id comes back | `codex exec resume [--json] <thread-id> <prompt>`: same thread id | `--resume <chatId>`: same session id |
| Unknown session on resume | exit 1, `result.subtype=error_during_execution`, stderr `No conversation found with session ID: …` | exit 1, stderr `thread/resume failed: no rollout found for thread id …` | **exit 0**: silently starts a new chat with that id. Can't be detected |
| Session id | `session_id` on every line (first: `system/init`) | `thread.started.thread_id` | `session_id` on every line (first: `system/init`) |
| Structured output | `--json-schema <schema>` | `--output-schema <file>` | none |
| Sign-in check | `claude auth status` → JSON `{loggedIn, authMethod, subscriptionType}` | `codex login status` → text `Logged in using ChatGPT` (exit 0) | `cursor-agent status --format json` → `{isAuthenticated}` |
| Usage / windows (headless) | **Yes.** `rate_limit_event.rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization 0–1, resetsAt unix-s}`, plus `status` (`allowed`/`rejected`) | **Not in `exec --json`.** The session log `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl` has `event_msg/token_count.rate_limits.{primary,secondary}.{used_percent, window_minutes (300/10080), resets_at unix-s}` | **None.** Only token counts in `result.usage` |
| Cost / tokens | `result.total_cost_usd`, `result.usage` | `turn.completed.usage` | `result.usage` |
| Interactive (attach) | `claude --resume <id>` | `codex resume <id>` | `cursor-agent --resume <id>` |

The recorded Codex 0.162.1 `--help` does not list `--yolo`; it lists `--dangerously-bypass-approvals-and-sandbox`. Cursor's recorded `--help` lists `--yolo` as an alias for `--force`. Harness uses Codex's recorded `workspace-write` mode for automated jobs and does not pass an unrecognized alias. The Phase 3 live run confirmed Codex work completes in that mode.

## Event mapping

**Claude** `stream-json`: `system/init` → session; `assistant.message.content[]` → `text` = message, `tool_use` = tool_call (Write/Edit/MultiEdit/NotebookEdit carry `input.file_path` → file_change); `user.tool_use_result` ignored; `rate_limit_event` → window snapshot, and `status: rejected` → `rate_limit` (window from `rateLimitType`); `result` → result (`is_error` → ok=false).

**Codex** `--json`: `thread.started` → session; `item.completed` with `agent_message` → message, `command_execution` → tool_call, `file_change` → file_change; `turn.completed.usage` → usage; `error` / `turn.failed` → error (rate limit by message pattern); end of stream with exit 0 and an agent message → result ok.

**Cursor** `stream-json`: `system/init` → session; `assistant` → message; `thinking` ignored; `tool_call/started` → tool_call (`editToolCall.args.path` → file_change); `result` → result.

## Unknowns
- What Codex and Cursor print on a real usage limit (patterns are best-effort; `limitPattern` falls back to `rate_limit` with window `unknown`).
- Whether Cursor exposes plan usage anywhere. Treated as `unknown` plus the manual budget.

## Usage sources (recorded 2026-10-16)

- **Codex 0.162.1 app-server.** `codex app-server` speaks JSON-RPC 2.0 over stdio: `initialize` (`clientInfo: {name, version}`), the `initialized` notification, then `account/rateLimits/read` (params `null`). The reply's `rateLimits.primary` / `.secondary` carry `usedPercent`, `windowDurationMins` (300 = 5h, 10080 = 7d) and `resetsAt` (unix seconds), plus `planType`. No model runs; no quota is spent. Recorded (account ids redacted) in `fixtures/codex/app-server-ratelimits.json`. The protocol also has `ConsumeAccountRateLimitResetCredit`; harness never calls it. Schema: `codex app-server generate-json-schema --out <dir>`.
- **Claude Code 2.1.301.** `rate_limit_event` lines in stream-json still carry `unifiedWindows.five_hour` / `seven_day` with `utilization` (0–1) during live runs (seen at 0.84 / 0.58 on 2026-10-15). There is still no way to read usage without a run, so harness shares the latest reading across all projects on the same account.
- **Cursor agent 2026.10.14.** No usage or token data in `-p` output. Use a manual budget (`harness limits set <route> --window budget --budget "40 runs/day"`).

## Drift check (2026-10-16)

`harness doctor` runs each installed CLI's `--help` (Codex: `exec --help` and `exec resume --help`) and checks that every flag harness passes is still listed (`USED_FLAGS` in `packages/adapters/src/drift.ts`); a missing flag blocks, a version newer than the recorded one (`RECORDED_VERSIONS`) is a warning. Claude Code's `--help` is captured through a file descriptor, not a pipe: it calls `process.exit()` and loses whatever is still in a pipe's buffer (cut mid-line at about 16 KB), which made `--verbose` look missing. `fixtures/claude/help.txt` was re-recorded from 2.1.301; the only change from 2.1.285 is that `--client-data-url` (unused by harness) is gone. Live runs on 2.1.301 (2026-10-15) parsed normally.

