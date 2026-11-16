# OpenCrewBot Verification Report

Generated from live execution against the running Next.js 16 server (`http://127.0.0.1:3000`), isolated SQLite test runner (`npm test` -> `scripts/verify-all.mjs` + `scripts/verify-core.ts`), and actual dev server restart checks, with zero paid API keys configured.

---

## 1. Environment & Build Verification
- `npx tsc --noEmit`: **PASS** (0 errors)
- `npm run build` (`next build`): **PASS** (0 errors)
- `npm run lint` (`eslint`): **PASS** (0 errors)
- `npm test` (`scripts/verify-all.mjs`): **PASS** (9/9 isolated core suite checks + 9 live HTTP/API integration checks)
- `GET /api/bootstrap` without paid keys: **PASS** — returns `8` bots (`Scout`, `Quill`, `Atlas`, `Analyst`, `Growth`, `Engineer`, `Finance`, `Ops`, all using `ollama/qwen2.5:3b`) and `4` rooms (`Studio`, `Market Intelligence`, `Product & Engineering`, `MeetUniversity Campaign` with zero duplicate members and `Growth` included in `Studio`).
- `GET /api/models`: **PASS** — returns catalog with `ollama/qwen2.5:3b` and `ollama/qwen3:4b`.
- `GET /api/connections`: **PASS** — returns `{"composio":{"enabled":false,"apps":[]},"mcpServers":[],"github":{"configured":false,"source":"none"}}` without blocking.
- Local Ollama reachability check (`http://127.0.0.1:11434/api/tags`): **Unreachable (`false`)** inside the Google AI Studio cloud container, as expected because container localhost does not reach the user's Windows laptop. Verified `providerId: "ollama"` OpenAI-compatible streaming and the repeated invalid tool-call circuit breaker against isolated ephemeral mock `/v1/chat/completions` servers in `scripts/verify-core.ts`; real Windows laptop Ollama remains **NOT TESTED** from cloud and is documented in `docs/WINDOWS_OLLAMA_SETUP.md`.
- GitHub authentication check: **Not configured** in container (`GITHUB_TOKEN`, `COMPOSIO_API_KEY`, and GitHub MCP token are all unset). Verified `github_repos_list` strict input validation, permission scoping, `Link`-header pagination, `401` handling, and clear connection-required errors against an isolated mock GitHub REST API server in `scripts/verify-core.ts`; live `api.github.com` listing against a real GitHub account remains **NOT TESTED** until credentials are supplied.

---

## 2. Priority Test Results (Observed Output)

### Priority 1 — Scheduled Workflows & Persistence Across Restart
- **Schedule creation, edit (`PATCH`), run (`POST .../run`), and delete**: **PASS** — verified full CRUD lifecycle via `/api/schedules` and `/api/schedules/[id]`.
- **Persistence across real server restart**: **PASS** — created a persisted schedule, stopped and restarted the Next.js server, and confirmed `GET /api/schedules` retained the exact schedule row after restart.
- **Automatic due execution & retry handling**: **PASS** — background 5s in-process ticker and `willRetry` retry scheduling verified against SQLite (`schedules`, `schedule_runs`). Limitation: auto-ticking runs only while Node server is running.

### Priority 2 — Sample CSV, Multipart Upload & Dynamic Analysis
- **`samples/meetuniversity_campaigns.csv` (8 rows)**: **PASS** — verified via `GET /api/csv?path=samples/meetuniversity_campaigns.csv` and `data-analysis` skill:
  - Total Revenue: `2,621,900`
  - Total Cost: `885,000`
  - Total Profit: `1,736,900` (`66.25%` margin)
  - Funnel: `608 conversions / 7,340 leads (8.28%)`
- **Multipart CSV upload & missing-value / binary guards (`POST /api/csv`)**: **PASS** — uploaded CSV with blank fields accurately reported `dataQuality.missingValueCount: 2`; binary payload (`\u0000\u0001binary`) and empty CSV were rejected with HTTP `400`.

### Priority 3 — Eight Reusable Skills (`POST /api/skills/run`) & Source Honesty
All **8** required skills executed via HTTP and returned structured deliverables + Markdown reports:
1. `Market Research`: **PASS** (returned `liveResearchAvailable: false`, `sources: []`, zero fabricated URLs when `TAVILY_API_KEY` unset)
2. `Competitor Analysis`: **PASS** (returned `liveResearchAvailable: false`, `sources: []`, zero fabricated URLs when `TAVILY_API_KEY` unset)
3. `Financial Modelling`: **PASS** (verified unit economics + HTTP `400` rejection when `budgetAllocation` does not sum to `100%`)
4. `Presentation Creation`: **PASS**
5. `Email Drafting`: **PASS**
6. `Code Review`: **PASS**
7. `Data Analysis`: **PASS**
8. `Lead Generation`: **PASS**

### Priority 4 — Memory Persistence & Cross-Agent Isolation Across Restart
- **Private bot `MEMORY.md` & shared room `MEMORY.md`**: **PASS** — verified `Scout` private memory does not leak into `Analyst` system prompt, room shared memory (`data/workspaces/rooms/<roomId>/MEMORY.md`) loads via `roomMemoryForPrompt`, and both survive a real Next.js server restart cleanly.

### Priority 5 — Three Permission Levels, Approval Centre & Replay Blocking
- **Permission classification (`toolCategory`)**: **PASS** (`read_csv` -> `read`, `memory_add`/`room_memory_add` -> `edit`, `browser_click` -> `execute`, `mcp_1_search` -> `read`, `mcp_1_create_issue` -> `mcp`, `COMPOSIO_*` -> `mcp`).
- **Approval Centre & Rejection Replay Block**: **PASS** — suspended `awaiting-approval` calls surface in `listPendingApprovals()` / `GET /api/approvals`; `respondToApproval(..., false)` updates tool part to `"denied"`; replaying `respondToApproval(..., true)` for the rejected `toolCallId` throws `"This action was rejected and is permanently blocked from executing."`

### Priority 6 — Multi-Agent Delegation Hardening (`src/lib/server/delegation.ts`)
- **Room membership enforcement**: **PASS** — rejects `@analyst` and `Quill` in `Product & Engineering` with `"not a member of room"`.
- **Missing task IDs & wrapper tolerance**: **PASS** — `DelegationToolInputSchema` + `normalizeDelegationInput` auto-generate deterministic unique `task_1`, `task_2`, ... when `id` is omitted, and reject missing/empty `tasks` cleanly.
- **Placeholder/cycle rejection**: **PASS** — rejects `Jenny`, `DevTeam1`, `DevTeam2`, `agent_1`, self-dependencies, and cycles (`A -> B -> A`).
- **Parallel DAG execution, SQLite `delegation_runs`, failure propagation & recovery**: **PASS** — executes independent tasks in parallel, passes upstream outputs downstream, persists snapshots to `delegation_runs`, marks dependents of failed tasks `blocked`, and recovers via `fallbackAssignee`.

---

## 3. Known Limitations
1. **Remote Container vs Windows Laptop Ollama**: Google AI Studio's cloud container cannot reach `127.0.0.1:11434` on a local Windows PC. Live `qwen2.5:3b` / `qwen3:4b` inference requires running OpenCrewBot locally (see `docs/WINDOWS_OLLAMA_SETUP.md`).
2. **In-Process Scheduler**: Schedule definitions and run history persist in SQLite across restarts, and missed due schedules catch up on `boot()`, **but background 5-second ticking only runs while the Node.js server process is active**. Stopping the server pauses automatic triggers until restarted.
3. **Simulated Demo Model**: When neither local Ollama nor `NEBIUS_API_KEY` is available, `createMockModel` runs scripted demo responses (`model: "mock"`) explicitly labeled **Simulated demo mode** while executing real local tools (`read_csv`, `run_skill`, `memory_add`, `room_memory_add`).
4. **Optional Cloud Integrations**: `Tavily`, `Browserbase`, `Composio`, `TypeSafe Jev`, and `Nebius` remain gracefully disabled (`Not configured`) unless their optional env vars are supplied.
