# OpenCrewBot final submission guide

## What this version changes

- Greetings and short acknowledgements are answered without loading a model or agent tools.
- Ordinary direct-message questions on an Ollama-configured bot use Ollama's native `/api/chat` endpoint with `think: false`, no tools, a short text-only transcript, and a 384-token output cap.
- Explicit integrations, research, coding, multi-step work, room messages, and non-general task routes remain on the existing Mastra agent workflow.
- Shared project-memory tools are only registered for bots whose shared-memory authorization is active. The execute-time authorization check remains in place.
- The system prompt no longer encourages proactive memory writes.
- Regression tests cover routing decisions and the native Ollama request's `think: false`, `stream: false`, no-tools configuration.

## Install without losing your local connection

1. Stop the old server with `Ctrl+C`.
2. Extract this ZIP into a new folder first.
3. Copy the contents of the inner `OpenCrewBot-final` folder into your existing OpenCrewBot project folder, replacing source files when prompted.
4. Preserve your existing `.env`, `data/`, and `.git/` folders. They contain local credentials, OAuth identity/settings, database state, and Git history. Do not overwrite them with empty copies.
5. In the existing project folder, run:

   ```powershell
   pnpm install --frozen-lockfile
   pnpm test
   pnpm lint
   pnpm build
   pnpm dev
   ```

6. Open the localhost URL printed by Next.js.

## Smoke tests before recording

1. Send `hi` to Scout. Expected: `Hi! How can I help?` with no Thinking panel/tool call.
2. Send `What is AI?`. Expected: a short direct answer using the lightweight Ollama route; no long reasoning trace and no tool calls.
3. Send `List all my GitHub repositories.` Expected: the GitHub listing tool runs and returns the repository table. Check its completeness indicator; do not claim all pages were fetched if it says not verified.
4. Send a normal complex task (for example, `Explain how this project is structured`). Expected: the regular agent workflow remains available.

## Demo recording outline (2–3 minutes)

1. Introduce OpenCrewBot and its multi-agent interface.
2. Show Scout's local Ollama model configuration (do not show secrets).
3. Send `hi` and `What is AI?` to demonstrate responsive lightweight chat.
4. Show GitHub connected through Composio OAuth and ask for the repository list.
5. Show the returned repository table and total count. Do not show `.env`, API keys, OAuth tokens, or private data that should not be in the demo.
6. Briefly show Studio/Atlas/Quill if required by the assignment.
7. Close with the key value: local-model chat plus connected-app workflows.

## GitHub push

Run these from the existing project folder after reviewing `git status`:

```powershell
git status
git add src tests package.json DEMO_SUBMISSION.md FINAL_SUBMISSION_GUIDE.md GITHUB_FAST_FIX_NOTES.md
git commit -m "Improve fast chat routing and GitHub workflow"
git push
```

Do not add `.env`, `data/`, `node_modules/`, `.next/`, or local database files. Verify the remote repository and branch before pushing if this is not already configured.

## Verification note

This package was syntax-checked across 105 TypeScript/TSX source files. The focused fast-chat tests pass. The full suite could not be completed in the packaging environment because project dependencies (`zod`, `@mastra/core`, `@libsql/client`, etc.) are not installed there. Run the full commands above on the submission machine and only report successful results after they complete.
