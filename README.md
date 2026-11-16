# OpenCrewBot

<div align="center">

<img src="docs/logo.svg" alt="OpenCrewBot mascot" width="96" height="96">

# OpenCrewBot

### Local-First Multi-Agent AI Workforce Platform

**An AI-powered collaborative workspace featuring 8 specialized agents, 4 collaboration rooms, persistent memory, reusable skills, and automated workflows — without requiring paid AI inference APIs.**

Built with Next.js 16 · Mastra · SQLite · Ollama · TypeScript

[Features](#key-features) · [Architecture](#architecture) · [Quick Start](#quick-start) · [Demo Video](#demo-video) · [Documentation](#documentation)

</div>

---

## Demo Video

**Project Demonstration:** [Watch OpenCrewBot Demo](https://drive.google.com/file/d/1nAkFYRF62Rm3qUPnGpbEap0kzwaKLFbv/view?usp=sharing)

The demonstration covers:
- Eight specialized AI agents and four collaboration rooms.
- Individual agent conversations and capabilities.
- Multi-agent task delegation and collaboration.
- CSV-based business analysis.
- Persistent agent memory.
- Reusable skills and integration configuration.
- Local Ollama model integration.

---

## Overview

OpenCrewBot is a local-first multi-agent AI workforce platform designed to organize specialized AI agents into collaborative teams.

Instead of relying on a single general-purpose assistant, OpenCrewBot provides dedicated agents for research, writing, planning, data analysis, marketing, software engineering, finance, and operations.

Agents can work individually or collaborate through shared rooms, structured task delegation, persistent memory, and reusable skills.

The application uses locally hosted Ollama models, with `qwen2.5:3b` as the default model and `qwen3:4b` as an alternative.

## Key Features

### 1. Eight Specialized AI Agents

| Agent | Responsibility |
|---|---|
| Scout | Market Research |
| Quill | Writing and Content Creation |
| Atlas | Planning and Coordination |
| Analyst | Data Analysis and Spreadsheets |
| Growth | Marketing and Campaigns |
| Engineer | Software Engineering |
| Finance | Financial Modelling |
| Ops | Operations and Scheduling |

Each agent has a dedicated role and can be configured to use supported model providers.

### 2. Four Collaboration Rooms

| Room | Purpose |
|---|---|
| Studio | General-purpose collaboration |
| Market Intelligence | Research and competitive analysis |
| Product & Engineering | Technical planning and development |
| MeetUniversity Campaign | Marketing and campaign execution |

Rooms provide a shared workspace for agents to collaborate on common objectives.

The delegation system supports structured tasks, dependency validation, execution tracking, parallel task waves, and failure handling.

Actual task execution depends on room membership, model availability, and successful tool execution.

### 3. Local AI Inference

OpenCrewBot supports local inference through Ollama.

- Default model: `qwen2.5:3b`
- Alternative model: `qwen3:4b`
- Default endpoint: `http://127.0.0.1:11434`
- No paid cloud inference API is required for local model execution.

When a local model or configured cloud provider is unavailable, the application can use an explicitly labelled simulated demo mode.

**Note:** Lightweight local models may struggle with complex tool calling and simultaneous multi-agent workflows. Execution timeouts and model limitations can affect delegation reliability.

### 4. Persistent Memory

OpenCrewBot supports:

- Individual agent memory.
- Shared room memory.
- Persistent `MEMORY.md` files.
- Memory editing and retrieval.
- Persistence across application restarts.

### 5. Eight Reusable Skills

The platform includes eight reusable skills:

1. Market Research
2. Competitor Analysis
3. Financial Modelling
4. Presentation Creation
5. Email Drafting
6. Code Review
7. Data Analysis
8. Lead Generation

Skills can be invoked through the application and integrated into agent workflows.

### 6. CSV and Spreadsheet Analysis

The CSV analysis functionality supports:

- CSV file upload and parsing.
- Dynamic numerical calculations.
- Revenue and cost analysis.
- Profit and margin calculations.
- Conversion funnel analysis.
- Data quality and missing-value checks.
- Business recommendations based on uploaded data.

Sample dataset:

`samples/meetuniversity_campaigns.csv`

### 7. Permission Management

Three permission levels are supported:

| Permission | Behaviour |
|---|---|
| Restricted | Read-only access |
| Ask | Requires approval for protected actions |
| Full | Allows configured actions |

The approval workflow supports pending, approved, and rejected action states.

### 8. Scheduled Workflows

The scheduler supports:

- One-time workflows.
- Interval-based workflows.
- Daily schedules.
- Weekly schedules.
- Execution history.
- Failure tracking and retry handling.

Schedule definitions and execution history are stored in SQLite.

**Limitation:** Automatic background execution uses an in-process scheduler and therefore requires the Node.js application server to remain running.

### 9. External Integrations

The application includes integration points for external services and tools, including:

- GitHub-related integration.
- Composio.
- MCP servers.
- Browser automation.
- Tavily research integration.
- Optional Jev routing.

External integrations require appropriate configuration, credentials, and permissions. Their availability is separate from the core local application.

---

## Architecture

The application follows a modular architecture built around Next.js, Mastra, and SQLite.

```text
OpenCrewBot
│
├── Frontend
│   ├── Dashboard
│   ├── Agent Management
│   ├── Room Management
│   ├── Chat Interface
│   ├── Memory Inspector
│   └── Connections
│
├── Backend
│   ├── Agent Runtime
│   ├── Model Routing
│   ├── Delegation Engine
│   ├── Skills Engine
│   ├── CSV Processing
│   ├── Memory Management
│   ├── Permissions
│   └── Scheduler
│
├── AI Inference
│   └── Ollama
│       ├── qwen2.5:3b
│       └── qwen3:4b
│
└── Persistence
    ├── SQLite
    ├── Agent Memory
    └── Shared Room Memory
```

### Technology Stack

| Technology | Purpose |
|---|---|
| Next.js 16 | Full-stack application framework |
| React 19 | User interface |
| TypeScript | Type-safe development |
| Mastra | AI agent orchestration |
| Ollama | Local AI inference |
| SQLite / LibSQL | Persistent data storage |
| Tailwind CSS | UI styling |
| Zod | Input validation |
| pnpm | Package management |

---

## Quick Start

### Prerequisites

- Node.js 22.13 or later.
- pnpm.
- Ollama.
- Windows, macOS, or Linux.

### 1. Clone the repository

```bash
git clone https://github.com/Ujjwal5619P/OpenCrewBot.git
cd OpenCrewBot
```

### 2. Download the Ollama models

```bash
ollama pull qwen2.5:3b
```

Optional alternative:

```bash
ollama pull qwen3:4b
```

### 3. Install dependencies

```bash
pnpm install
```

If pnpm requests approval for dependency build scripts, inspect and approve the required packages:

```bash
pnpm approve-builds
```

### 4. Configure environment variables

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Review the environment configuration before starting the application.

### 5. Start the application

```bash
pnpm dev
```

### 6. Open the application

Visit:

http://localhost:3000

---

## Environment Variables

All listed external service credentials are optional for the core local application.

| Variable | Purpose | Default |
|---|---|---|
| `OLLAMA_BASE_URL` | Local Ollama endpoint | `http://127.0.0.1:11434` |
| `OLLAMA_MODEL` | Default inference model | `qwen2.5:3b` |
| `NEBIUS_API_KEY` | Optional cloud model provider | Not configured |
| `TAVILY_API_KEY` | Web research integration | Not configured |
| `BROWSERBASE_API_KEY` | Browser automation | Not configured |
| `COMPOSIO_API_KEY` | External application integrations | Not configured |
| `TYPESAFE_API_KEY` | Optional Jev routing | Not configured |
| `OPENCREWBOT_DATA_DIR` | SQLite and memory storage directory | `./data` |

Never commit `.env` or expose API credentials publicly.

---

## Testing and Verification

Run the available project checks:

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm lint
pnpm build
```

The project includes verification scripts:

- `scripts/verify-core.ts`
- `scripts/verify-all.mjs`

These cover core application behaviour, APIs, delegation, memory, CSV processing, permissions, and scheduling.

Actual results should be checked in the environment where the application is deployed.

---

## Documentation

Additional project documentation:

- [Architecture and Scheduler Limitations](docs/ARCHITECTURE.md)
- [Feature Audit](docs/FEATURE_AUDIT.md)
- [Seven-Demo Runbook](docs/DEMO_RUNBOOK.md)
- [Windows Ollama Setup](docs/WINDOWS_OLLAMA_SETUP.md)
- [Verification Report and Known Limitations](docs/VERIFICATION_REPORT.md)
- [Sample Campaign Dataset](samples/meetuniversity_campaigns.csv)

---

## Known Limitations

1. **Local Model Capacity:** Lightweight models such as Qwen 2.5 3B may struggle with complex reasoning, structured tool calls, and simultaneous multi-agent workflows.

2. **Execution Timeouts:** Complex agent workflows can exceed the configured inference timeout, particularly when multiple agents share the same local model.

3. **Cloud Preview Networking:** Remote hosted environments cannot directly access Ollama running on a developer's local machine through `127.0.0.1`.

4. **External Integrations:** GitHub, browser automation, web research, and third-party integrations require their respective authentication and configuration.

5. **Scheduler Runtime:** Automatic background scheduling requires the Node.js server to remain active.

6. **Multi-Agent Reliability:** Successful task completion depends on valid room membership, model tool-calling capability, and backend execution. Not every complex collaboration workflow has been verified under all model configurations.

---

## License

This project is licensed under the [MIT License](LICENSE).

---

<div align="center">

**OpenCrewBot — Building collaborative AI workforces, locally.**

Developed as an AI Engineer assignment project.

</div>
