# OpenCrewBot Architecture

## Overview

OpenCrewBot is a single-workspace multi-agent orchestration web application built on **Next.js 16 (App Router)**, **Mastra (`@mastra/core`)**, and **SQLite (`@libsql/client`)**. It runs locally with zero paid API requirements via **Ollama (`qwen2.5:3b` / `qwen3:4b`)** and degrades transparently to an explicitly labeled simulated demo model when neither Ollama nor Nebius Token Factory is reachable.

## Core Runtime Layers

### 1. Client UI & SSE Event Store (`src/components/`, `src/lib/client/`)
- **State Store (`src/lib/client/store.ts`)**: Subscribes to `/api/events` (`EventSource` SSE) and merges `message`, `delta`, `running`, `bots-changed`, `rooms-changed`, `memory-changed`, `room-memory-changed`, `connections-changed`, `schedules-changed`, and `browser-live` events in real time.
- **Navigation & Drawers (`src/components/OpenCrewBotApp.tsx`, `Sidebar.tsx`, `SchedulesPanel.tsx`, `ApprovalsPanel.tsx`, `Inspector.tsx`)**:
  - **8 Pre-seeded Bots**: `Scout`, `Quill`, `Atlas`, `Analyst`, `Growth`, `Engineer`, `Finance`, `Ops`.
  - **4 Collaboration Rooms**: `Studio`, `Market Intelligence`, `Product & Engineering`, `MeetUniversity Campaign`.
  - **Approval Centre Drawer (`ApprovalsPanel.tsx`)**: Sidebar footer action & live pending badge listing all awaiting approvals (`GET /api/approvals`) with **Approve once**, **Reject**, and **Open chat**.
  - **Scheduled Workflows Drawer (`SchedulesPanel.tsx`)**: Create, edit (`PATCH /api/schedules/[id]`), pause/resume, run manually, delete schedules, and inspect execution history.

### 2. Agent Harness (`src/lib/server/runtime.ts`)
- Each bot maintains one `AgentController` instance and one `Memory` store backed by `data/mastra.db`.
- Each conversation (`dm:<botId>` or `room:<roomId>`) maps to a `Session` thread keyed by `${conversationId}:${botId}:${generation}`.
- Turns are guarded by a `90s` model-response timeout (`TURN_TIMEOUT_MS`), a `maxSteps: 10` agent cap, and a `TurnFolder` repeated failing tool-call circuit breaker (aborts when a tool fails 2+ times or 3+ total tool errors occur in a single turn).
- **GitHub Integration (`src/lib/server/github.ts`, `src/lib/server/connectors.ts`)**: Exposes `github_repos_list` strictly to bots granted GitHub permission (`github:env`, `composio:github`, or GitHub `mcp:<id>`), validating `{ visibility, perPage, page }` with `.strict()` Zod schemas, following GitHub `Link` pagination, and verifying auth without fabricating repositories.
- **Model Resolution (`resolveBotModel`)**:
  1. If `bot.model` starts with `ollama/` and `isOllamaReachable()` succeeds at `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`), routes to Ollama's OpenAI-compatible endpoint (`/v1`).
  2. Else if `NEBIUS_API_KEY` is configured, routes to `nebius/<modelId>`.
  3. Else if any local Ollama endpoint is reachable, falls back to `ollama/${DEFAULT_OLLAMA_MODEL}`.
  4. Else falls back to `createMockModel()` (`model: "mock"`), which clearly marks output as simulated demo output while still invoking real local tools (`memory_add`, `room_memory_add`, `read_csv`, `run_skill`, `browser_*` approval checks).

### 3. Three-Tier Permission Model & Replay Guard (`runtime.ts`, `tools.ts`)
Each tool resolves via `toolCategory(toolName)` to `"read"`, `"edit"`, `"mcp"`, `"execute"`, or `"other"`, mapped against `bot.approval`:

| Policy | `read` | `edit` (`memory_*`, `room_memory_*`) | `mcp` (mutating) | `execute` (`browser_*` actions) |
| --- | --- | --- | --- | --- |
| `restricted` (Read-only) | Allow | **Deny** | **Deny** | **Deny** |
| `ask` (Ask first) | Allow | Allow | **Ask** (pauses at `awaiting-approval`) | **Ask** (pauses at `awaiting-approval`) |
| `full` (Full access) | Allow | Allow | Allow | Allow |

Rejected actions transition to `status: "denied"` via `respondToApproval(..., false)`, never reach external execution, and are permanently blocked from any retry/replay via `resolvedApprovals` and SQLite `findToolPartByCallId`.

### 4. Collaboration Rooms & Delegation DAG (`src/lib/server/rooms.ts`, `src/lib/server/delegation.ts`)
- **Routing (`decideResponders`)**: `@everyone` -> `@mention` -> TypeSafe Jev (`pickResponders`, optional) -> Room Lead fallback. Runs that already executed `delegate_tasks` skip duplicate `@mention` re-dispatch on the same message.
- **Structured Task Delegation (`delegate_tasks` -> `normalizeDelegationInput` + `validateDelegationPlan` + `executeDelegationPlan`)**:
  - `DelegationToolInputSchema` + `normalizeDelegationInput` accept optional task IDs (auto-generating unique `task_1`, `task_2`, ... when omitted), unwrap alternate wrapper payloads, and strictly validate non-empty `tasks`.
  - Enforces 1–20 tasks, unique task IDs, valid room membership (rejects placeholders such as `Jenny` / `DevTeam1` and outsiders not in that room), and cycle/self-dependency rejection via DFS.
  - Executes ready dependency waves in parallel with `Promise.all`, forwarding completed upstream outputs into downstream task prompts, and persists each snapshot (`pending -> running -> completed/failed/blocked/stopped`) to SQLite (`delegation_runs`, `GET /api/delegations`).
  - **Failure & Recovery**:
    - Unrecovered worker errors mark the task `"error"` (`outcome: "failed"`) and propagate `"blocked"` to downstream dependents.
    - Tasks specifying `fallbackAssignee` automatically retry on the fallback room member, record `recoveredFrom`, and unblock downstream tasks if the fallback succeeds.

### 5. Reusable Skills & Dynamic CSV Analysis (`src/lib/server/skills.ts`, `src/lib/server/csv.ts`)
- **8 Invocable Skills** (`GET /api/skills`, `POST /api/skills/run`, and bot tools `list_skills` / `run_skill`):
  1. `market-research` (Market Research — uses live `@tavily/core` when `TAVILY_API_KEY` is configured; explicitly sets `liveResearchAvailable: false` and `sources: []` without fabricating URLs when unconfigured)
  2. `competitor-analysis` (Competitor Analysis — uses live `@tavily/core` when configured; zero fabricated URLs when unconfigured)
  3. `financial-modelling` (Financial Modelling — includes 100% `budgetAllocation` sum validation)
  4. `presentation-creation` (Presentation Creation)
  5. `email-drafting` (Email Drafting)
  6. `code-review` (Code Review)
  7. `data-analysis` (Data Analysis)
  8. `lead-generation` (Lead Generation)
- **CSV Upload & Analyzer (`POST /api/csv`, `GET /api/csv`, `read_csv`)**: Supports multipart CSV upload from the chat composer (`+ -> Upload CSV`) into `data/uploads/`, rejects empty/binary/non-numeric files, counts missing cells and malformed rows (`dataQuality`), computes revenue/cost/profit/ROAS/margins/funnel conversion/monthly deltas dynamically, and outputs JSON + Markdown tables.

### 6. Scheduled Workflows (`src/lib/server/scheduler.ts`, `src/lib/server/db.ts`)
- **Persistence**: `schedules` and `schedule_runs` tables in `data/opencrewbot.db` (`SCHEMA_VERSION = 4`).
- **Execution**: Supports `once`, `interval`, `daily`, `weekly`, inline editing (`PATCH /api/schedules/[id]`), manual `Run now` (`POST /api/schedules/[id]/run`), and retry backoff (`retryCount <= maxRetries`).
- **In-Process Limitation**: Background ticking (`setInterval` every 5 seconds via `ensureSchedulerStarted()` on `boot()`) only fires while the Node.js server process is alive. Schedule definitions and run history persist in SQLite across restarts, and due schedules catch up when the server boots, but there is no external OS cron/worker daemon executing workflows while the server is stopped.

### 7. Storage Layout
- `data/opencrewbot.db`: Bots, rooms, conversation transcripts, `delegation_runs`, settings (`mcp.servers`, `workforce.version = 3`), schedules, schedule runs.
- `data/mastra.db`: Mastra `AgentController` thread & memory persistence.
- `data/workspaces/<botId>/MEMORY.md`: Per-bot long-term private memory with automatic secret redaction.
- `data/workspaces/rooms/<roomId>/MEMORY.md`: Shared room-level collaborative memory (`room_memory_add` / `room_memory_edit` and Room Inspector `Memory` tab).
- `data/uploads/*.csv`: User-uploaded CSV files for dynamic analysis.
- `samples/meetuniversity_campaigns.csv`: Sample business dataset for `Analyst` / `read_csv`.
