# Research: where harness goes next (2026-10-16)

What the field has learned about multi-agent coding, checked against what harness does today, and what to build next. Findings marked **verified here** were checked on this machine; the rest come from the sources at the end (many are practitioner blogs, so treat their numbers as claims).

## 1. Usage visibility decides whether pooling works

Pooling (M21) sends each task to the subscription with the most room. It is only as good as the usage data, and today only Codex reports any.

| Vendor | What exists | Status in harness |
| --- | --- | --- |
| **Codex** | **Verified here:** Codex 0.162.1's app-server protocol has `account/rateLimits/read` (plus an `AccountRateLimitsUpdatedNotification`), which returns 5h and weekly usage and reset times without running a model. `codex exec --json` reportedly returns `rate_limits: null`; the session log's `token_count` events carry them. | Reads the session log after a run. |
| **Claude** | `rate_limit_event` in the stream-json output carries `status` and `resetsAt`; `utilization` appears only once a bucket crosses a threshold. No non-interactive equivalent of `/usage` (open feature requests). | Reads `rate_limit_event`; otherwise `unknown`. |
| **Cursor** | No usage or token data in `agent -p` output; limits are dollar-based and visible only in the dashboard. | `unknown`. |

**Implications**
- Poll Codex with `account/rateLimits/read` before dispatch: exact, free, fresh.
- For Claude, a `rate_limit_event` with status "allowed" and no utilization means "below the warning threshold", which is a useful upper bound rather than "unknown". Combine it with the learned per-task cost (M9 estimator) to estimate a range, and label it `[inferred]`.
- For Cursor, ask once in setup for a manual budget (runs or minutes per 5h) and learn from limit errors.

## 2. Pick the model by outcome, not by guess (cascade)

Research and practitioner reports distinguish *routing* (guess difficulty up front, pick a model) from *cascading* (try the cheap model, escalate only when a check fails). Up-front routing misroutes hard work; cascades work best when failure is cheap to detect. In coding, "almost right" output from a small model can cost more in retries than one frontier call, so the metric that matters is **cost per completed task, including retries**.

harness already has the cheap, reliable failure signal: its own checks. So:
- Start S tasks on the small tier, and **escalate the tier on repair** (S → M → L model) instead of retrying the same model. Record the outcome per tier.
- **Verified here:** Claude Code 2.1.301 has `--effort <level>`. Effort could be a cheaper lever than switching models (and keeps the session). This needs recording against the real CLI first (AGENTS.md rule 3); fixtures are from 2.1.285.
- Report cost per merged task by tier in the ledger, so tiers are tuned from data, not intuition.

## 3. Split only what is independent

Studies and vendor reports agree: parallel agents win on **independent** subtasks and lose on interdependent edits. Multi-agent setups use several times the tokens, and independent agents that cannot see each other repeat each other's mistakes. Anthropic's own guidance calls multi-agent a poor fit for tightly coupled coding work.

harness is well placed (separate worktrees, independent checks, a reviewer, the board, the lead), but the planner should be stricter:
- **Split only when the parts touch disjoint files**; otherwise give the whole request to one agent. This can be checked deterministically from `files_hint` after planning (like `fitRoles`): overlapping, dependency-free tasks are merged into one task or chained.
- Measure it: the PRD's quality metric (merged within 3 attempts vs a one-agent baseline on the same tasks) is the honest test of whether the team beats a single agent. Build that report.

## 4. Memory: files, resets and a checklist

Anthropic's long-running-agent harness uses an initializer, a progress file, git history, and a machine-readable feature list with a pass or fail flag per item. It found compaction alone was not enough; a fresh session rebuilt from a compact handoff worked better. LangChain's Deep Agents and others converge on the same idea: durable memory in plain files, loaded at start.

harness already does the board (M18), handoff and fresh sessions (M19). Next:
- **A per-request checklist** on the board: the acceptance criteria of every task in the request as `[ ]`/`[x]`, ticked by harness when checks pass and confirmed by the lead. The lead then works from a list instead of prose, and "done" is visible.
- **Long tool output to files:** keep only the head and tail of check output in prompts and point to the full log (repair prompts already use the last 200 lines; make the path explicit).
- **Project memory that outlives requests:** let the lead promote recurring `NOTE:` lines (conventions, gotchas) into a "Project facts" section that every future prompt carries, with a size cap.

## 5. Conflicts: integrate serially, let the agent try once

The common pattern is isolation plus serial integration: merge one branch, rebase the next onto the result, repeat (harness does this). Tools such as Kepler, CodeRabbit and Syncwright now let an agent resolve the remaining conflicts, with a confidence gate and re-verification.

For harness: on `merge.conflict`, send the task back to its own agent session with the conflicting files and the integration diff, let it rebase and resolve in its worktree, then run the full gate and review again. Only a second conflict, or a failed gate, goes to the person. Checks keep this safe.

## 6. Where harness stands among similar tools

Parallel-agent tools are now common: Conductor (macOS app, Claude Code and Codex in worktrees), Claude Squad (tmux, many CLIs), Vibe Kanban, Composio's Agent Orchestrator (one PR per agent), Parallel Code, the Codex app, and Claude Code's native worktrees. Almost all of them **run agents side by side and leave coordination and verification to you**.

harness's distinct value is the combination nobody else has:
1. **One team across vendors, paid by subscriptions**, with quota-aware scheduling and pooling.
2. **Independent verification** (its own checks, a separate-vendor reviewer) before anything merges.
3. **Coordination**: deterministic routing, a shared board, handoff, and a lead.

Gaps against them: a visual diff review (Conductor), PR per agent (Composio), and a phone or web view (you run harness from remote control today).

## 7. Vendor drift is the biggest maintenance risk

**Verified here:** the installed Claude Code (2.1.301) is newer than the recorded fixtures (2.1.285). Flags and stream shapes change often. harness should notice drift on its own: `harness doctor` re-records `--help` for each CLI, compares it with `fixtures/`, and warns when a flag harness uses has changed or disappeared.

## Recommended milestones

| # | Milestone | Based on |
| --- | --- | --- |
| **M31** | **Usage you can trust**: Codex `account/rateLimits/read` before dispatch; Claude below-threshold bound plus learned cost; Cursor manual budget in setup; pool ranks by known room first | §1 |
| **M32** | **Agent-resolved conflicts**: one rebase-and-resolve attempt by the task's own agent, then full gate and review | §5 |
| **M33** | **Escalate on failure**: repairs move up a model tier (and later effort level); cost per merged task by tier | §2 |
| **M34** | **Split only independent work**: merge or chain planned tasks whose files overlap; one agent when nothing splits cleanly | §3 |
| **M35** | **Request checklist on the board**: acceptance criteria ticked by checks, confirmed by the lead; lead works from it | §4 |
| **M36** | **Team vs one agent**: the quality ledger and a savings report per request | §2, §3 |
| **M37** | **Vendor drift check** in `doctor`; re-record Claude 2.1.301 fixtures | §7 |
| **M38** | **Project facts**: recurring notes promoted to a capped, always-loaded section | §4 |
| **M39** | Phone-friendly status page or PR per task, whichever you want first | §6 |

M31 comes first: pooling, the reason harness exists, depends on it.

## Sources

- [Expose per-bucket rate-limit utilization to headless SDK consumers (anthropics/claude-code #50518)](https://github.com/anthropics/claude-code/issues/50518)
- [Expose Max plan usage limits via Claude Code API/SDK (anthropics/claude-code #32796)](https://github.com/anthropics/claude-code/issues/32796)
- [Emit rate_limits in exec mode JSONL output (openai/codex #14728)](https://github.com/openai/codex/issues/14728)
- [Expose full usage/limits data in CLI (openai/codex #15281)](https://github.com/openai/codex/issues/15281)
- [Reading Codex rate limits without burning them](https://tech.hatada.jp/en/posts/reading-codex-rate-limits-without-burning-them)
- [Add a cursor-agent usage adapter (jonathanong/auto-harness #795)](https://github.com/jonathanong/auto-harness/issues/795)
- [Effective harnesses for long-running agents (Anthropic)](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Long-running agents (Addy Osmani)](https://addyosmani.com/blog/long-running-agents/) and [Agent harness engineering](https://addyosmani.com/blog/agent-harness-engineering/)
- [Context engineering in Deep Agents (LangChain)](https://docs.langchain.com/oss/python/deepagents/context-engineering)
- [Model routing for coding agents: real savings? (Unblocked)](https://getunblocked.com/blog/model-routing-coding-agents/)
- [AgentRouter: heterogeneous model routing for agentic workflows (arXiv 2609.22951)](https://arxiv.org/pdf/2609.22951)
- [Task-to-model optimization for coding assistants (arXiv 2608.08528)](https://arxiv.org/pdf/2608.08528)
- [Empirical evaluation of agent frameworks on code tasks (arXiv 2511.00872)](https://arxiv.org/pdf/2511.00872)
- [Terminal agents suffice for enterprise automation (arXiv 2604.00073)](https://arxiv.org/pdf/2604.00073)
- [2026 Agentic Coding Trends Report (Anthropic)](https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf?hsLang=en)
- [The code agent orchestra (Addy Osmani)](https://addyosmani.com/blog/code-agent-orchestra/)
- [9 open-source agent orchestrators (Augment)](https://www.augmentcode.com/tools/open-source-agent-orchestrators)
- [Best tools for parallel AI coding agents (Nimbalyst; vendor, self-ranked)](https://nimbalyst.com/blog/best-tools-for-running-parallel-ai-coding-agents/)
- [Resolve merge conflicts (CodeRabbit)](https://www.coderabbit.ai/blog/introducing-resolve-merge-conflicts)
- [GitKraken merge conflict tooling](https://gitkraken.com/features/merge-conflict-resolution-tool)
