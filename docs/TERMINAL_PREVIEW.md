# Terminal preview

A sample harness session with multiple agents and a shared task queue.

```
██╗  ██╗ █████╗ ██████╗ ███╗   ██╗███████╗███████╗███████╗     (a huge gradient banner)
██║  ██║██╔══██╗██╔══██╗████╗  ██║██╔════╝██╔════╝██╔════╝
███████║███████║██████╔╝██╔██╗ ██║█████╗  ███████╗███████╗
██╔══██║██╔══██║██╔══██╗██║╚██╗██║██╔══╝  ╚════██║╚════██║
██║  ██║██║  ██║██║  ██║██║ ╚████║███████╗███████║███████║
╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝╚══════╝

╭──────────────────────────────────────────────────────────────╮
│ ✦ harness v0.1.0 · shop                                      │
│ ~/code/shop · ⎇ harness/integration                          │
│                                                              │
│ your 5 agents                                                │
│   ✻ backend-1     claude  opus      working                  │
│   ◆ frontend-1    codex   default   idle                     │
│   ▲ fullstack-1   cursor  default    working                 │
│   ✻ reviewer-1    claude  opus      idle                     │
│   ✻ planner-1     claude  opus      idle                     │
╰──────────────────────────────────────────────────────────────╯
 ❯ build a watchlist with live quotes and a login page
 ⏺ Quote feed and login first; the panel builds on the feed.
 · → backend: Quote feed adapter
 · → fullstack: Login page and session
 · → frontend: Watchlist panel (after T-001)
 ⠧ backend-1 T-001 Quote feed adapter · editing src/server/feed.js · 7m
╭──────────────────────────────────────────────────────────────╮
│ ❯ team  tell your team what to build…                        │
╰──────────────────────────────────────────────────────────────╯
 ✦ shop  ▶ running  2 working · 1 queued          /agents · /usage · /help
```
