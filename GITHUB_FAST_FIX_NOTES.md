# GitHub and responsive-chat fixes

## GitHub repository listing

- Uses the existing Composio OAuth connection; no personal access token is required.
- Requests up to 100 repositories per page where the discovered action exposes pagination parameters.
- Follows subsequent pages when supported, deduplicates, sorts newest-first, and reports completeness honestly.
- The result is rendered as a compact Markdown table.

## Shared project memory

- Shared `project_memory_read` and `project_memory_add` tools are registered only when the specific bot has explicit shared-memory authorization.
- The execution-time authorization guard remains as defence in depth.
- The runtime signature includes the authorization state, so granting/revoking access rebuilds the toolset.
- The prompt explicitly prohibits proactive memory writes.

## Responsive local chat

- Greetings and short acknowledgements return deterministic text without invoking Ollama, Mastra, or tools.
- Ordinary direct-message questions for Ollama-configured bots use native `/api/chat` with `think: false`, `stream: false`, no tools, up to eight short recent text messages, a 384-token output cap, and a 10-minute model keep-alive.
- Explicit integrations, research, coding, multi-step requests, room messages, and non-general task routes retain the Mastra agent workflow.
- Tests cover routing decisions and verify the native Ollama request flags.

## Verification in packaging environment

- 105 TypeScript/TSX source files passed TypeScript transpilation syntax checks.
- 4 focused fast-chat tests passed.
- The full existing test suite was attempted but could not fully run because this packaging environment has no installed project dependencies (`zod`, `@mastra/core`, `@libsql/client`, etc.). Run `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm lint`, and `pnpm build` locally before submission.
