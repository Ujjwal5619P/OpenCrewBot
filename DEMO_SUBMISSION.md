# Demo and GitHub Submission Checklist

## Local setup

1. Install Node.js 22 or later and pnpm 11.
2. Install dependencies:
   ```powershell
   pnpm install --frozen-lockfile
   ```
3. Copy `.env.example` to `.env` and fill in the required local configuration.
4. Start Ollama and ensure the selected local model is installed:
   ```powershell
   ollama pull qwen3:4b
   ```
5. Start the app:
   ```powershell
   pnpm dev
   ```
6. Open `http://127.0.0.1:3000`.

## GitHub integration demo

1. Add the Composio API key to the local `.env` file. Never commit `.env`.
2. In OpenCrewBot, open Connections and connect GitHub through the OAuth flow.
3. Open the Scout agent settings and enable the GitHub connection.
4. Ask Scout: `List all repositories in my connected GitHub account.`
5. Verify the chat shows the `github_list_repositories` tool step and that the answer contains only names returned by GitHub through Composio.
6. If the connection is inactive, reconnect GitHub in Connections and retry.

The repository-listing tool is read-only. It uses the active Composio GitHub session and does not require a personal GitHub access token.

## Fast chat behaviour

For direct-message conversations using an Ollama general model, greetings and acknowledgements are answered locally without loading the agent controller. Ordinary knowledge questions use Ollama's native `/api/chat` endpoint with `think: false`, no tools, recent text-only conversation history, and a bounded 384-token response. Explicit integration requests, research, coding, and multi-step work continue through the normal Mastra agent workflow. Shared project-memory tools are only registered for bots with explicit shared-memory authorization.

## Checks before recording

Run:
```powershell
pnpm test
pnpm lint
pnpm build
```

Do not record a successful test/build claim unless the command completes successfully on the submission machine.

## Suggested 2–3 minute demo video

1. **Opening (10–15 sec):** introduce OpenCrewBot and its purpose.
2. **Agent setup (20–30 sec):** show Scout, local Ollama model selection, and enabled GitHub connection.
3. **OAuth connection (15–20 sec):** show GitHub as connected in Connections. Do not reveal API keys or tokens.
4. **Live task (30–45 sec):** ask Scout to list repositories; show the tool execution step and actual returned repository names.
5. **Safety (15–20 sec):** explain that repository listing is read-only and uses the connected OAuth account, not a pasted personal token.
6. **Closing (10 sec):** summarize the local-model + connected-app workflow.

## GitHub submission checklist

- [ ] Commit source code, tests, documentation, `.env.example`, and `pnpm-lock.yaml`.
- [ ] Do not commit `.env`, API keys, OAuth tokens, `node_modules`, `.next`, or runtime `data/`.
- [ ] Add a clear README section with setup instructions and screenshots.
- [ ] Include the demo video link in the GitHub README or submission form.
- [ ] Confirm the repository is public/private as required by the assignment.
- [ ] Confirm the final commit is pushed and the submission link opens.
