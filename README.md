<div align="center">

<img src="docs/logo.svg" alt="OpenCrewBot mascot" width="96" height="96">

# OpenCrewBot

### Local-first multi-agent workspace with zero paid API requirements.

**Run an 8-agent team across 4 collaboration rooms powered by local Ollama (`qwen2.5:3b` / `qwen3:4b`), Mastra `AgentController`, persistent `MEMORY.md`, 8 reusable skills, dynamic CSV analysis, 3 permission tiers, and SQLite-backed scheduled workflows.**

Built with Next.js 16 · Mastra · SQLite (`@libsql/client`) · Ollama (`qwen2.5:3b` / `qwen3:4b`)

</div>

---

## Key Capabilities

- **Zero Paid API Keys Required**: Runs out of the box using local **Ollama** (`http://127.0.0.1:11434`, `qwen2.5:3b` default, `qwen3:4b` supported). Cloud providers (`NEBIUS_API_KEY`, `TAVILY_API_KEY`, `BROWSERBASE_API_KEY`, `COMPOSIO_API_KEY`, `TYPESAFE_API_KEY`) are completely optional and never block startup.
- **Honest Simulated Fallback**: When neither local Ollama nor Nebius is reachable (such as inside a remote cloud preview), replies are explicitly labeled **Simulated demo mode** while local tools, memory, permissions, CSV computation, skills, and scheduling execute genuinely.
- **8 Pre-seeded Bots**: `Scout` (Research), `Quill` (Writing), `Atlas` (Planning), `Analyst` (Data & Spreadsheets), `Growth` (Marketing & Campaigns), `Engineer` (Software Engineering), `Finance` (Finance & Modeling), and `Ops` (Operations & Scheduling).
- **4 Collaboration Rooms**: `Studio`, `Market Intelligence`, `Product & Engineering`, and `MeetUniversity Campaign` with `@mention` routing, `@everyone`, Lead fallback, optional Jev routing, and structured DAG task delegation (`delegate_tasks`) supporting parallel waves, dependency validation, failure propagation, and `fallbackAssignee` recovery.
- **8 Invocable Skills** (`src/lib/server/skills.ts`): `Market Research`, `Competitor Analysis`, `Financial Modelling`, `Presentation Creation`, `Email Drafting`, `Code Review`, `Data Analysis`, and `Lead Generation`.
- **Dynamic CSV Analysis** (`read_csv`): Reads workspace CSVs under `samples/` or `data/` (including `samples/meetuniversity_campaigns.csv`) and computes revenue, cost, profit, margins, funnel conversion, and period trends dynamically.
- **3 Permission Tiers**: `restricted` (**Read-only**, denies edits/actions automatically), `ask` (**Ask first**, pauses on `awaiting-approval` and skips rejected actions), and `full` (**Full access**).
- **Scheduled Workflows**: Create one-time, interval, daily, or weekly workflows targeting any bot or room, persisted in SQLite with automatic in-process execution, failure retry tracking, and run history.

---

## Documentation Index

- [Architecture & Scheduler Limitations](docs/ARCHITECTURE.md)
- [Feature Audit](docs/FEATURE_AUDIT.md)
- [Seven-Demo Runbook](docs/DEMO_RUNBOOK.md)
- [Windows Local Ollama Setup (`qwen2.5:3b` & `qwen3:4b`)](docs/WINDOWS_OLLAMA_SETUP.md)
- [Verification Report & Known Limitations](docs/VERIFICATION_REPORT.md)
- Sample dataset: [`samples/meetuniversity_campaigns.csv`](samples/meetuniversity_campaigns.csv)

---

## Quick Start (Local Windows / macOS / Linux with Ollama)

Requirements: **Node.js 22.13+** and **pnpm** (or **npm**).

1. Pull local models in Ollama:
   ```sh
   ollama pull qwen2.5:3b
   ollama pull qwen3:4b
   ```
2. Install and start OpenCrewBot:
   ```sh
   pnpm install
   cp .env.example .env
   pnpm dev
   ```
3. Open **http://localhost:3000**.

See [docs/WINDOWS_OLLAMA_SETUP.md](docs/WINDOWS_OLLAMA_SETUP.md) for step-by-step PowerShell setup and cloud preview limitations.

---

## Environment Variables (All Optional)

| Variable | Purpose | Default / Behavior if Unset |
| --- | --- | --- |
| `OLLAMA_BASE_URL` | Local Ollama endpoint | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | Default local Ollama model | `qwen2.5:3b` |
| `NEBIUS_API_KEY` | Optional cloud models via Token Factory | Uses Ollama if reachable, else labeled simulated mode |
| `TAVILY_API_KEY` | Optional web search / page reading | Displays **Not configured** |
| `BROWSERBASE_API_KEY` | Optional cloud browser automation | Displays **Not configured** |
| `COMPOSIO_API_KEY` | Optional 3rd-party OAuth apps | Displays **Not configured** |
| `TYPESAFE_API_KEY` | Optional Jev auto-room classifier | Falls back to Room Lead |
| `OPENCREWBOT_DATA_DIR` | SQLite & `MEMORY.md` directory | `./data` |

---

## Known Limitations

- **In-Process Scheduler**: Schedule definitions and execution history persist in `data/opencrewbot.db`, and due schedules catch up on startup, but automatic background ticking runs only while the Node server process is running.
- **Cloud Container Network Boundary**: Hosted preview environments (such as Google AI Studio) cannot reach `127.0.0.1:11434` on a developer's laptop. Export and run locally for live Ollama inference.
- **License**: [MIT](LICENSE)
