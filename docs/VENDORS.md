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

## Event mapping

**Claude** `stream-json`: `system/init` → session; `assistant.message.content[]` → `text` = message, `tool_use` = tool_call (Write/Edit/MultiEdit/NotebookEdit carry `input.file_path` → file_change); `user.tool_use_result` ignored; `rate_limit_event` → window snapshot, and `status: rejected` → `rate_limit` (window from `rateLimitType`); `result` → result (`is_error` → ok=false).

**Codex** `--json`: `thread.started` → session; `item.completed` with `agent_message` → message, `command_execution` → tool_call, `file_change` → file_change; `turn.completed.usage` → usage; `error` / `turn.failed` → error (rate limit by message pattern); end of stream with exit 0 and an agent message → result ok.

**Cursor** `stream-json`: `system/init` → session; `assistant` → message; `thinking` ignored; `tool_call/started` → tool_call (`editToolCall.args.path` → file_change); `result` → result.

## Unknowns
- What Codex and Cursor print on a real usage limit (patterns are best-effort; `limitPattern` falls back to `rate_limit` with window `unknown`).
- Whether Cursor exposes plan usage anywhere. Treated as `unknown` plus the manual budget.
