<div align="center">

<img src="docs/logo.svg" alt="OpenCrewBot mascot" width="96" height="96">

# OpenCrewBot

### Your own team of AI bots, in one chat app.

**An open-source alternative to Grok Bot, on open models. Each bot has its own model, tools, memory and cloud browser.**

Built with [Mastra](https://mastra.ai) and [Nebius Token Factory](https://tokenfactory.nebius.com) · [Get started](#get-started) · [Overview](#overview) · [Architecture](#architecture) · [Features](#features) · [Data and privacy](#data-and-privacy)

![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)
![Mastra](https://img.shields.io/badge/harness-Mastra-6d28d9)
![Nebius Token Factory](https://img.shields.io/badge/models-Nebius%20Token%20Factory-e0ff4f?labelColor=0b0b0b)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Built by Studio1 team](https://img.shields.io/badge/built%20by-Studio1%20team-ff6b1a)](https://studio1hq.com)

Run OpenCrewBot on your own machine. Use hosted models from Nebius Token Factory or local models from Ollama; Tavily, Browserbase and Jev are optional keys for search, browsing and room routing. Without an available model provider, it runs in mock mode so you can try the interface first.

</div>

---

<div align="center">

<table><tr><td>

<img src="docs/screenshots/hero.png" alt="OpenCrewBot: a chat with Scout, a research bot, showing a web search, a sourced answer and a memory save, with the bot's details panel open" width="900">

</td></tr></table>

</div>

_Ask, search, answer, remember. Scout searches the web with Tavily, answers with its sources, and saves a decision to its own `MEMORY.md`. Staged example content; the interface is real._

## Overview

OpenCrewBot treats AI as a messaging app. Every contact in the sidebar is a bot with its own persona, its own open-source model, its own tools and its own memory. Talk to one bot directly, or put several in a room and let them split the work.

**A starting point, not a hosted product.** You run the app and bring your own keys. It's early: the [Features](#features) section says what's included and what has been verified so far.

### Bots

Give each bot a name, a role, instructions, a provider/model and a set of tools. Optional task routes and an explicit fallback are saved per bot. Each reply shows reported tokens and an estimated cost when the provider supplies enough information.

**Choose the model from the bot's Details.** **Change** opens a searchable model sheet with Nebius Token Factory discovery and up to 20 installed Ollama models. Task routes can select General conversation, Research, Coding, Data analysis, and Planning models. An optional fallback is selected before the turn starts; OpenCrewBot never retries a request on another provider after a model call begins. A model change applies to the bot's next reply without a restart.

The details panel keeps a short summary of the bot, with the full editor one click away. Changes apply from the bot's next reply.

### Create agents with AI

Choose **Create Agent with AI** in the sidebar and describe the specialist you need. OpenCrewBot proposes a name, role, instructions, model, tools, memory guidance, approval setting, skills guidance and expected output format. Review the draft and edit it in the existing bot form before saving; the usual `createBot()` path stores the bot and creates its private `MEMORY.md`.

With an available provider, the app uses a tool-capable configured model for live structured generation. Without an available provider, it creates a clearly labelled **simulated configuration** using deterministic local rules; no AI inference is claimed. In either mode, unavailable search or browser tools are disabled, approval defaults to **Ask first**, and no external integrations or skills runtime are added. Skills and output format are included as editable instructions.

### Rooms

Put bots in a room and talk to all of them at once. @mention a bot to choose who answers, or `@everyone`. With no mention, an **Auto** room asks [Jev](https://typesafe.ai), TypeSafe's decision model, to pick the best bot in a few hundred milliseconds. If Jev isn't sure, the room's lead answers. A bot can @mention a teammate to hand work on, up to two hops.

Room agents also have collaboration tools to share research, ask and answer member questions, and delegate structured tasks with an objective, context, expected output, assignee and dependencies. Addressed questions start a bounded answer task for that room member. Independent delegated tasks use the existing execution scheduler in parallel; dependent tasks wait for their prerequisites. A reviewer can be assigned a verification task, whose result is recorded only when the reviewer returns an explicit first-line verdict. Open a room's **Work** tab to see task owners, statuses, intermediate outputs, exchanges and verification results; approval and ask-you prompts can be answered there without changing the bot's permissions.

Delegation is limited to room members, 20 tasks per plan, three delegation levels and 60 collaboration messages per room per hour. Repeated delegation patterns in the same chain are rejected with a recorded reason. Delegated work uses each bot's existing `runTurn()` and approval policy; delegation does not grant tool permissions. Live models can choose to use these tools. Mock mode is scripted and does not reliably demonstrate autonomous delegation, so confirm that work appears in the room's Work tab before treating it as started.

Delegated plans, outputs and collaboration messages are persisted with the execution history. Pending work resumes during startup recovery; interrupted tasks with possible external effects become `outcome_unknown`. Approval or question waits resume normally while the server is running, but a server restart cannot resume the suspended in-memory approval flow and fails that task closed.

<div align="center">

<table><tr><td>

<img src="docs/screenshots/room.png" alt="The Studio room: Atlas, picked by Jev with 91% confidence, plans a launch and hands research to Scout and drafting to Quill" width="900">

</td></tr></table>

</div>

_One message, three bots. Jev picks Atlas to answer, Atlas hands research to Scout and drafting to Quill. Staged example content._

### Memory

Each bot keeps private notes in its own plain Markdown file, `data/workspaces/<botId>/MEMORY.md`. The first 200 lines load into that bot's prompt; the bot can update its file with `memory_add` and `memory_edit`, and you can edit it in the Memory tab. Those files are never copied into shared project memory.

The inspector's **Shared** tab edits `data/PROJECT_MEMORY.md` and controls an explicit per-agent access list, which starts empty. Authorized agents can read shared notes on request with `project_memory_read` and add notes with `project_memory_add`; they cannot edit or delete the file. Agent additions are always attributed to the agent and marked **unverified**. The user can add attributed user/project-decision entries and edit the Markdown directly. Common secret-like values are redacted before writing, and the file has a 64 KiB limit. Shared text is sent to a configured model only when an authorized agent reads it. Revoking an agent starts a fresh model-side thread for its future turns; already-disclosed content and an in-flight turn cannot be recalled, and prior local thread history is retained. Existing individual files are not migrated or rewritten.

<div align="center">

<table><tr><td>

<img src="docs/screenshots/memory.png" alt="Scout's Memory tab showing its MEMORY.md, with notes about the person and decisions" width="900">

</td></tr></table>

</div>

_The Memory tab is the file itself. The panel refreshes live when the bot writes to it._

### Ask before acting

On **Ask first**, a bot stops before each browser action and shows an approval card in chat. **Allow once** runs it; **Deny** skips it and the bot carries on. Bots can also pause to ask you a question, with suggested answers as buttons, and resume when you reply. **Full access** acts without asking.

<div align="center">

<table><tr><td>

<img src="docs/screenshots/approval.png" alt="Quill asks to open tokenfactory.nebius.com in its browser and waits for Allow once or Deny" width="900">

</td></tr></table>

</div>

_Nothing happens until you choose. Staged example content._

### Tools

| Tool | What it does | Powered by |
| --- | --- | --- |
| Web search | Search, read pages and crawl sites, with sources shown under the answer | [Tavily](https://tavily.com) via `@mastra/tavily` |
| Memory | Read and update the bot's own `MEMORY.md`; optionally read/add explicitly shared project notes | Local Markdown files |
| Code mode | The model writes one TypeScript function that calls several tools at once, so multi-step questions take one round trip | Mastra Code Mode, in a QuickJS (WebAssembly) sandbox |
| Browser | A real cloud browser for pages that need clicks, forms or JavaScript. Watch it live from the chat and click in to take over | [Browserbase](https://www.browserbase.com) via Mastra `AgentBrowser` |
| Ask me | Pause and ask you a question with a card in chat | Mastra `ask_user` |

### Reusable skills

The skill library contains Market Research, Competitor Analysis, Financial Modelling, Presentation Creation, Email Drafting, Code Review, Data Analysis, and Lead Generation. Assign skills to a bot in its editor; the bot can discover them and load their instructions on demand. A skill is guidance, not a tool or permission grant. The editor marks required tools that are missing, and server-side loading refuses an unassigned skill or one whose required tools are unavailable. Presentation Creation drafts slide content rather than creating a file; Email Drafting does not send mail. Any actual connected-app action still uses the bot's Composio tools and Module G approval policy.

### Connections

Give bots access to Slack, GitHub, Gmail, Notion and the rest of your tools. Open **Connections** from the plug icon in the sidebar:

- **Apps via [Composio](https://composio.dev).** Click **Connect**, sign in on the app's own page, and come back. Composio handles each app's sign-in and tokens, with 1,000+ apps available through search.
- **Your own MCP servers.** Add any remote MCP server by URL and token. There's a preset for GitHub's official server (`https://api.githubcopilot.com/mcp/`, with a personal access token). **Add and test** connects straight away and reports how many tools it offers.
- **GitHub, Gmail and Slack actions.** Search Composio's action catalog from each connected app row. Discovery only lists actions; it does not run them. If `COMPOSIO_API_KEY` is missing, these integrations are unavailable and are not simulated in mock mode.

Then switch each connection on for the bots that should have it, in the bot's Details. Lookups run on their own; anything that changes something (sending a message, opening an issue) shows an approval card first, unless the bot has full access. Tokens stay on the server.

## Architecture

### Mastra runs the bots

OpenCrewBot doesn't build its own agent loop. Each bot gets a Mastra [`AgentController`](https://mastra.ai/docs/harness/agent-controller), and each conversation gets its own session. Mastra handles the model calls, thread history, tool approvals and question pauses. OpenCrewBot folds the controller's events into chat messages and streams them to the browser over one SSE connection.

![Diagram](/public/image.png)

Provider credentials stay on the server. A bot configured for Nebius uses the scripted mock model only when Nebius is not configured and no explicit fallback is set. Ollama is used only when its server endpoint is reachable and the selected model is discovered; mock responses are labelled simulated and have unknown token/cost values.

### Chief of Staff executions

The execution API accepts one complex instruction and returns a validated task plan, including assigned bots, required capabilities and dependencies. Independent tasks run concurrently; dependent tasks receive completed outputs as context. Task turns use the existing `AgentController` runtime, so bot tool permissions and approval prompts are unchanged.

Planning uses the configured Planning route (or the bot's default model) of the best-matching planning bot. If no provider is available for that selection, the API creates a deterministic simulated plan and marks it `plannerMode: "simulated"`; it does not report simulated work as AI inference.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/executions` with `{ "instruction": "..." }` | Plan, persist and start an execution |
| `GET` | `/api/executions` | List recent execution history |
| `GET` | `/api/executions/:id` | Read its plan, task statuses and output |
| `POST` | `/api/executions/:id/cancel` | Cancel pending or running work |

Executions and tasks are stored in the app's versioned SQLite schema. A server restart marks in-flight work as interrupted rather than silently replaying possible side effects; tasks with possible tool activity become `outcome_unknown` and require reconciliation, while executions that were still pending are resumed. Approval and question waits do not consume the task timeout; their request IDs are returned with the task and use the existing conversation approval and answer endpoints.

Startup recovery assumes one active server process owns the SQLite database. Do not run multiple OpenCrewBot server processes against the same database: a process starting up cannot distinguish another live process's running execution from work interrupted by a restart.

### Scheduled workflows

Create and manage schedules in **Settings → Scheduled workflows**. A workflow is planned once and stores its task assignments and dependency graph; each scheduled or manual run creates a fresh execution through the existing execution service and records its schedule ID. This reuses the normal task engine, `runTurn()` path, and current approval settings. Changing the instruction replans the saved workflow. Mock-mode plans remain explicitly labelled simulated.

One-time schedules use a local date/time and an IANA timezone. Daily and weekly schedules use wall-clock time in that timezone. During a daylight-saving fall-back overlap, the earlier matching instant is chosen; a wall-clock time that does not exist during a spring-forward gap is skipped for that date. Occurrences up to five minutes late run immediately. Older missed occurrences are recorded as skipped with no backfill. If the previous run is still active, the due occurrence is skipped rather than queued, so schedules never overlap. A paused recurring workflow resumes at its next future occurrence; an elapsed one-time schedule must be edited to a future time before it can resume.

Schedule definitions, occurrence claims, execution links and run history persist in the versioned SQLite database. A unique occurrence key prevents duplicate scheduled launches, and a database constraint prevents overlapping active runs. A claimed occurrence with no execution record can safely be recovered using its preassigned execution ID; an execution already persisted is recovered by the existing execution engine, which does not replay interrupted tasks that may have produced external effects. The in-process scheduler checks for due work every 15 seconds. Like other startup recovery, it assumes exactly one active application server process owns the database; it is not a distributed scheduler or a substitute for an always-on server.

### Approval and permission controls

Each bot can use **Ask First**, **Controlled Access**, or **Full Access**. Ask First preserves the existing read/edit behavior and pauses tools categorized as execution, connected-app/MCP, or other actions. MCP tools always require approval in Ask First and Controlled Access: their server-controlled names are not trusted as evidence that an action is read-only. Controlled Access only skips approval for exact configured tool IDs that are not classified as sensitive. Full Access skips individual approval prompts for tools actually registered to the bot, but does not add tools or grant arbitrary operating-system access. Code mode receives only the tools allowed by the same policy.

Pending actions and recent decisions appear in Settings → Approval Centre. Requests expire after 30 minutes and pending requests are cancelled on server startup because Mastra's suspended approval flow is in memory; they are not replayed after a restart. Approval decisions are persisted before the suspended tool is resumed, and a request can be decided only once. If resumption throws after approval, the action is marked `outcome_unknown` and is not retried automatically; reconcile it before retrying. Approval-preview redaction is pattern-based: it covers common credential field names and formats, but cannot detect every possible secret representation and should not be relied on as secret storage.

OpenCrewBot is a local, single-owner app without sign-in. Its local-owner decision identity is not multi-user authorization; keep it bound to localhost and do not expose the API to untrusted users.

## Get started

Use **Node.js 22.13 or newer** (developed on 24) and **pnpm**:

```sh
git clone https://github.com/Studio1-OSS/OpenCrewBot.git
cd OpenCrewBot
pnpm install
cp .env.example .env
pnpm dev
```

Open **http://localhost:3000**. On first run OpenCrewBot creates three bots (Scout for research, Quill for writing, Atlas for planning) and a room called Studio.

Add your keys to `.env`, then restart `pnpm dev`. Every key is optional:

| Variable | What it turns on |
| --- | --- |
| `NEBIUS_API_KEY` | Hosted models from [Nebius Token Factory](https://tokenfactory.nebius.com). Without it, a Nebius selection uses mock mode only when no fallback is configured. |
| `OLLAMA_BASE_URL` | Optional Ollama server URL (default `http://127.0.0.1:11434`). Up to 20 discovered installed models appear in the model picker. |
| `OLLAMA_API_KEY` | Optional server-side key for an authenticated Ollama-compatible endpoint. Never sent to the browser or agent prompt. |
| `TAVILY_API_KEY` | Web search, page reading and site crawls. |
| `BROWSERBASE_API_KEY` | Cloud browsers for bots with the Browser tool. |
| `BROWSERBASE_PROJECT_ID` | Optional. Inferred from the key when empty. |
| `BROWSERBASE_SESSION_MINUTES` | Optional cap on one browser session (default 15). |
| `COMPOSIO_API_KEY` | Connected apps (Slack, GitHub, Gmail, Notion and more) through [Composio](https://platform.composio.dev). |
| `TYPESAFE_API_KEY` | Jev routing in Auto rooms. Without it, the room's lead answers. |
| `JEV_MODEL` | Jev model id (default `jev-latest`). |
| `OPENCREWBOT_DATA_DIR` | Where data lives (default `./data`). |
| `OPENCREWBOT_ALLOWED_HOSTS` | Extra host names the API answers to, comma-separated. Only for deliberate setups behind your own sign-in. |

**No hosted or local model provider yet?** Try these in a bot's chat in mock mode:

- `remember that I like short answers` calls the memory tool and writes to `MEMORY.md`.
- `remember that release freeze is approved for the project` calls the shared-memory tool when that agent has been explicitly authorized.
- Mock mode uses scripted pattern matching; it exercises local tool routing, not live-model memory decisions.
- `ask me something` shows a question card and resumes when you answer.
- `open https://example.com` shows an approval card first, in a bot with the Browser tool on.
- `search for Nebius Token Factory` runs a real Tavily search once `TAVILY_API_KEY` is set.

## Data and privacy

Bots, rooms, chat transcripts, executions, scheduled workflows and their run history are stored in SQLite at `data/opencrewbot.db`. Mastra keeps each bot's model-side thread history in `data/mastra.db`. Private bot memories are `data/workspaces/<botId>/MEMORY.md`; shared project memory is `data/PROJECT_MEMORY.md`, with its authorized bot IDs stored in the existing SQLite settings table. Nothing leaves your machine except calls to the services you configure:

- **Nebius Token Factory** receives each bot's system prompt (including its private `MEMORY.md`), the conversation, and tool results. Shared project memory is included in tool results only after an authorized agent explicitly reads it.
- **Ollama** receives the prompt and tool results at the server-configured endpoint. By default it runs on `127.0.0.1`; an explicitly configured remote endpoint receives the same model input.
- **Chief of Staff planning** sends the instruction and available bot role descriptions/instructions to the selected configured model. Each assigned bot receives its task and completed dependency outputs.
- **Tavily** receives search queries and the URLs a bot reads or crawls.
- **Browserbase** runs the cloud browser, so it sees the pages a bot visits and anything typed into them. Sessions are released when a bot is reset or deleted, and expire after `BROWSERBASE_SESSION_MINUTES`.
- **Jev** receives the room name, member names and descriptions, the last few room messages and the new message, when an Auto room has no @mention.
- **Room collaboration** stores delegated tasks, intermediate outputs, research shares, questions, answers and verification results in the local SQLite database. These messages are included in room context sent to configured bot models.
- **Composio** holds the sign-ins for apps you connect, and receives the actions a bot runs in them.
- **Your MCP servers** receive the tool calls a bot makes to them. Their URLs and tokens are stored in `data/opencrewbot.db`.

OpenCrewBot sends no telemetry of its own. Review the privacy policy and retention settings of each service you connect.

It assumes one local owner and has no sign-in. To keep it that way, `pnpm dev` and `pnpm start` listen on `127.0.0.1` only, and the API refuses requests from other websites and requests addressed to any host but `localhost`. Don't expose it to the internet as-is.

## Features

| Area | Included |
| --- | --- |
| Bots | Name, role, instructions, color, model, tools and approval level per bot; pin, search, unread counts, live typing status |
| Agent creation | Natural-language agent drafts with live or explicitly simulated generation, editable before creation |
| Skills | Eight reusable, on-demand skills assigned per bot, with required-tool availability checks |
| Models | Per-bot Nebius/Ollama selection, task routing, explicit pre-turn fallback, and a persisted usage summary; unknown usage/cost stays unknown |
| Connections | Composio apps with one-click sign-in, your own MCP servers (GitHub preset), per-bot access, approval for actions |
| Chat | Streaming Markdown, reasoning, tool steps with sources, Stop, and messages queued while a bot is busy |
| Rooms | @mentions, `@everyone`, Auto routing with Jev, Lead and Everyone modes, hand-offs, bounded task delegation, research sharing, Q&A and verification |
| Executions | Chief of Staff plans, dependency-aware parallel tasks, retries, cancellation and persistent history |
| Memory | Private `MEMORY.md` per bot plus opt-in shared `PROJECT_MEMORY.md`, editable in the app, with provenance labels and secret redaction |
| Approvals | Ask First, Controlled Access and Full Access; persisted Approval Centre, plus ask-you question cards |
| Browser | Browserbase session per bot, embedded live view with takeover, release on reset |
| Code mode | Multi-tool TypeScript in a QuickJS sandbox with no filesystem or network access |
| Mock mode | Labelled scripted model responses; token usage and cost remain unknown |

Run focused task-graph and SQLite-history tests with `pnpm test`. These tests do not call live planning or bot models.

**What's been verified.** Existing Module A–I flows and the mock provider are covered by the repository tests. Model-provider catalog and routing behavior are tested with deterministic fixtures. No live Ollama inference, remote Ollama authentication, Nebius inference fallback, or per-model cost metadata was tested for this change. **Still to verify with live services:** Composio sign-in and app actions, Browserbase sessions, Jev routing, and how reliably each model calls tools.

### Extending it

- Let bots delegate to each other in direct chats with Mastra subagents.
- Add scheduled routines with Mastra schedules.
- Let you talk to bots from Slack or Discord with Mastra Channels.
- Add sign-in and multiple users before deploying it anywhere shared.
- Add voice: speak to a bot and have it read replies aloud.

## Project layout

- `src/lib/server/runtime.ts`: the harness glue. One `AgentController` per bot, one session per conversation, events folded into chat messages.
- `src/lib/server/models.ts`: provider/model discovery, capability checks, request-scoped routing, safe pre-turn fallback and pricing metadata.
- `src/lib/server/chief-of-staff.ts` and `execution-service.ts`: validated planning, persistent task scheduling and execution recovery.
- `src/lib/server/execution-core.ts`: dependency validation, retries and bounded parallel task execution.
- `src/lib/server/tools.ts`: which tools a bot gets, their approval categories, and how each looks in chat.
- `src/lib/server/skills/`: validated, reusable skill definitions and on-demand skill tools.
- `src/lib/server/rooms.ts` and `jev.ts`: room routing, catch-up context and hand-offs.
- `src/lib/server/collaboration.ts` and `collaboration-core.ts`: room membership, delegation limits, collaboration messages and verification.
- `src/lib/server/memory-files.ts`: private/shared Markdown memory reads, writes, provenance and redaction.
- `src/lib/server/project-memory.ts`: the persisted allowlist for shared project memory.
- `src/lib/server/browserbase.ts`: creates, announces and releases each bot's Browserbase session.
- `src/lib/server/mock-model.ts`: the scripted model used when no configured model is available.
- `src/components/`: the chat interface. `src/lib/client/store.ts` folds server events into state.

## Contributing

Issues and pull requests are welcome. Describe the workflow a change enables, run `pnpm exec tsc --noEmit` and `pnpm lint`, and say whether you tested it against live services or the mock model.

## License

[MIT](LICENSE) © 2026 Studio1HQ
