# OpenCrewBot Demonstration Runbook (7 Demos)

Prerequisites for **live local LLM inference**: run Ollama on Windows (`ollama serve`) with `qwen2.5:3b` (or `qwen3:4b`) pulled and start the app locally (see `docs/WINDOWS_OLLAMA_SETUP.md`).  
When run in Google AI Studio or without Ollama reachable, local tools, SQLite persistence, permissions, CSV computation, skills, and scheduling execute genuinely while LLM text turns are clearly labeled as **Simulated demo mode**.

---

## Demo 1 — Workforce & Model Configuration (Zero Paid Keys)
1. Start the app (`npm run dev` or `npm start`) with no paid API keys in `.env`.
2. Verify the dashboard loads immediately with **8 bots** (`Scout`, `Quill`, `Atlas`, `Analyst`, `Growth`, `Engineer`, `Finance`, `Ops`) and **4 rooms** (`Studio`, `Market Intelligence`, `Product & Engineering`, `MeetUniversity Campaign`).
3. Click **Settings** (gear icon) to inspect provider status:
   - Missing optional keys (`NEBIUS_API_KEY`, `TAVILY_API_KEY`, `BROWSERBASE_API_KEY`, `COMPOSIO_API_KEY`, `TYPESAFE_API_KEY`) show **Not configured** without blocking the workspace.
   - Local Ollama shows `http://127.0.0.1:11434` and default `qwen2.5:3b`.
4. Open any bot's **Details** inspector and click **Change** next to Model to switch between `ollama/qwen2.5:3b` and `ollama/qwen3:4b`.

---

## Demo 2 — Direct Messaging, Private `MEMORY.md` & Shared Room `MEMORY.md`
1. Select **Quill** or **Scout** in the sidebar.
2. Send: `remember that MeetUniversity targets Class 11 STEM and Commerce students in India`
3. Confirm `memory_add` completes (`Saved to memory`) and open **Details -> Memory** to view/edit `data/workspaces/<botId>/MEMORY.md`.
4. Open a room (e.g. **Market Intelligence**), open its **Inspector -> Memory** tab (`TopBar` menu -> **Shared room memory**), and save a shared decision in `data/workspaces/rooms/<roomId>/MEMORY.md` (or let a bot call `room_memory_add`).
5. Test secret redaction: sending credential-like tokens automatically redacts secrets before writing `MEMORY.md`.

---

## Demo 3 — Room Delegation (`@scout` to `@analyst` & Multi-Agent Rooms)
1. Open the **Market Intelligence** room (`Scout`, `Analyst`, `Atlas`, `Ops`).
2. Send: `@scout Please coordinate with @analyst to review our campaign metrics and Q2 priorities.`
3. Observe `Scout` respond (routed via `@mention`), hand off / `@analyst`, and `Analyst` respond in the shared room transcript.
4. For multi-step parallel + dependent workflows, `delegate_tasks` normalizes omitted task IDs (`task_1`, `task_2`, ...), enforces room membership (rejecting non-members and placeholders like `Jenny`/`DevTeam1`), runs independent waves in parallel (`executeDelegationPlan`), persists snapshots to `delegation_runs`, and supports `fallbackAssignee` recovery.

---

## Demo 4 — Real Spreadsheet Upload & Dynamic CSV Analysis (`Analyst`)
1. Select **Analyst** (or open `Market Intelligence` and mention `@analyst`).
2. Send: `Analyze samples/meetuniversity_campaigns.csv and calculate revenue, cost, profit, and trends.`
3. Verify `read_csv` computes dynamically from `/samples/meetuniversity_campaigns.csv` (8 rows):
   - **Total Revenue:** `2,621,900`
   - **Total Cost:** `885,000`
   - **Total Profit:** `1,736,900` (`66.25%` margin)
   - **Funnel:** `608 conversions / 7,340 leads (8.28%)`
   - **Monthly Trends:** `2026-01` -> `2026-04` with profit deltas (`+347,300`, `-50,900`, `-152,800`).
4. Click **`+` -> Upload CSV** in the composer to upload a custom `.csv` into `data/uploads/` (missing cells are counted cleanly under `dataQuality.missingValueCount`, while binary/empty files are rejected).

---

## Demo 5 — Eight Reusable Skills
Invoke any of the 8 skills via chat (`run skill <skill-id>`), **Skills** drawer, or `POST /api/skills/run`:
1. `market-research` — **Market Research** (Scout; uses Tavily when configured, reports `liveResearchAvailable: false` with zero fabricated URLs when unset)
2. `competitor-analysis` — **Competitor Analysis** (Scout; live Tavily when configured, zero fabricated URLs when unset)
3. `financial-modelling` — **Financial Modelling** (Finance — computes CAC, LTV, LTV:CAC, net profit, break-even, and validates 100% budget allocation)
4. `presentation-creation` — **Presentation Creation** (Quill)
5. `email-drafting` — **Email Drafting** (Quill)
6. `code-review` — **Code Review** (Engineer — static security/reliability scan)
7. `data-analysis` — **Data Analysis** (Analyst — dynamic CSV pipeline)
8. `lead-generation` — **Lead Generation** (Growth)

---

## Demo 6 — Three Permission Levels, Approval Centre & Rejection Guard
1. Open a bot's **Details** -> **Approval** (3 levels):
   - **Read-only (`restricted`)**: Automatically denies `memory_*` / `room_memory_*` (`edit`) and `browser_*` (`execute`) actions without prompting (`status: "denied"`).
   - **Ask first (`ask`)**: Prompts for approval on mutating MCP / browser actions (`awaiting-approval`). Review pending requests either inline in chat or from the **Approval Centre** (`ShieldAlert` icon in the sidebar footer). Clicking **Reject** sets `status: "denied"` without executing and permanently blocks replaying that tool call ID.
   - **Full access (`full`)**: Executes `memory_add` and action tools without an approval prompt.

---

## Demo 7 — Scheduled Workflows, Inline Editing & Execution History
1. Click the **Schedules** (`CalendarClock`) icon in the sidebar footer to open **Scheduled workflows**.
2. Fill in **Name**, **Target**, **Prompt**, **Recurrence** (`Once`, `Every N minutes`, `Daily`, `Weekly`), and **Max retries**, then click **Create schedule**.
3. Click **Edit** on any schedule to adjust prompt/recurrence/timing via `PATCH /api/schedules/[id]`, or click **Run now** (`POST /api/schedules/[id]/run`).
4. Inspect **Recent execution history** for attempt status (`success` / `failed`), retry scheduling (`willRetry`), and **Open chat**.
