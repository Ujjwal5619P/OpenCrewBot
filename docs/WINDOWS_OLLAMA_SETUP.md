# Local Windows Ollama Setup (`qwen2.5:3b` & `qwen3:4b`)

> **Important Cloud Preview Note:**  
> Google AI Studio runs inside a remote cloud container. Its `127.0.0.1:11434` **cannot reach Ollama running on your Windows laptop**.  
> To demonstrate live local Qwen inference, export/clone this repository and run it directly on your Windows machine alongside Ollama.

---

## 1. Install and Start Ollama on Windows
1. Download and install Ollama for Windows from `https://ollama.com/download/windows`.
2. Open **PowerShell** or **Command Prompt** and pull the local models:
   ```powershell
   ollama pull qwen2.5:3b
   ollama pull qwen3:4b
   ```
3. Verify Ollama is serving on port `11434`:
   ```powershell
   curl http://127.0.0.1:11434/api/tags
   ```
   If Ollama is not running, start it with:
   ```powershell
   ollama serve
   ```

---

## 2. Export & Install OpenCrewBot Locally (Windows)
Requirements: **Node.js 22.13+** and **pnpm** (or **npm**).

1. Download/export the project archive from AI Studio (or clone the repository) and open PowerShell inside the project folder.
2. Create `.env` from `.env.example`:
   ```powershell
   Copy-Item .env.example .env
   ```
   Ensure `.env` contains (no paid keys needed):
   ```env
   OLLAMA_BASE_URL=http://127.0.0.1:11434
   OLLAMA_MODEL=qwen2.5:3b
   ```
   *(All cloud keys — `NEBIUS_API_KEY`, `TAVILY_API_KEY`, `BROWSERBASE_API_KEY`, `COMPOSIO_API_KEY`, `TYPESAFE_API_KEY` — can stay blank.)*

3. Install dependencies and start the server:
   ```powershell
   pnpm install
   pnpm dev
   ```
   Or using npm:
   ```powershell
   npm install
   npm run dev
   ```

4. Open **`http://localhost:3000`** in your browser.

---

## 3. Verifying Live Local Qwen Execution
1. Open **Settings** (bottom-left gear icon) and verify **Local inference (Ollama)** shows connected / available with `qwen2.5:3b` and `qwen3:4b`.
2. Send a message to **Scout** or **Analyst** — the reply badge should show `qwen2.5:3b` (not `Simulated demo mode`).
3. **Automatic migration & existing DBs:**  
   - On startup (`boot()`), `WORKFORCE_VERSION = 3` automatically seeds all **8 bots** (`ollama/qwen2.5:3b` default) and **4 rooms**, and non-destructively upgrades any legacy default `MiniMaxAI/MiniMax-M3` bot model entries to `ollama/qwen2.5:3b` when `NEBIUS_API_KEY` is unset.
   - `resolveBotModel` also routes non-Ollama bots to `ollama/qwen2.5:3b` whenever `NEBIUS_API_KEY` is unset and local Ollama is reachable.
4. **Tool calling note for 3B–4B models:** `qwen2.5:3b` supports OpenAI-compatible tool calls through Ollama `/v1`, while `qwen3:4b` often provides stronger multi-step tool reliability for structured `delegate_tasks` plans. You can switch any bot's model live in **Details** without restarting.
