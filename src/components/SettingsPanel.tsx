"use client";

import clsx from "clsx";
import { ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import type { ModelUsageSummary } from "@/lib/shared/types";
import { useApp } from "./OpenCrewBotApp";
import { Drawer } from "./ui";
import { ApprovalCenter } from "./ApprovalCenter";
import { ScheduledWorkflows } from "./ScheduledWorkflows";

function KeyRow({ name, envVar, ok, what, href }: { name: string; envVar: string; ok: boolean; what: string; href: string }) {
  return (
    <li className="px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[14.5px] font-medium">{name}</span>
        <span className={clsx("flex items-center gap-1.5 text-[12.5px]", ok ? "text-ok" : "text-faint")}>
          <span className={clsx("h-2 w-2 rounded-full", ok ? "bg-ok" : "bg-[#3a3a3a]")} />
          {ok ? "Connected" : "Not set"}
        </span>
      </div>
      <p className="mt-1 text-[13px] leading-snug text-mute">{what}</p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <code className="rounded-md bg-raised-2 px-1.5 py-0.5 font-mono text-[12px] text-mute">{envVar}</code>
        <a className="inline-flex items-center gap-0.5 text-[12.5px] text-mute hover:text-ink" href={href} target="_blank" rel="noopener noreferrer">
          Get a key <ArrowUpRight size={13} />
        </a>
      </div>
    </li>
  );
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { state } = useApp();
  const status = state.status;
  const [usage, setUsage] = useState<ModelUsageSummary[]>([]);
  const [usageError, setUsageError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    api.modelUsage().then(({ usage: rows }) => {
      if (active) setUsage(rows);
    }).catch((error) => {
      if (active) setUsageError(error instanceof Error ? error.message : "Couldn't load model usage.");
    });
    return () => {
      active = false;
    };
  }, []);
  return (
    <Drawer title="Settings" onClose={onClose}>
      <section>
        <h3 className="text-[12.5px] font-medium text-mute">API keys</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-mute">
          Keys live on the server in <code className="rounded-md bg-raised-2 px-1 font-mono text-[12px]">.env</code>, never in the browser. Add them,
          then restart <code className="rounded-md bg-raised-2 px-1 font-mono text-[12px]">pnpm dev</code>.
        </p>
        <ul className="mt-3 divide-y divide-line rounded-2xl bg-raised">
          <KeyRow
            name="Nebius Token Factory"
            envVar="NEBIUS_API_KEY"
            ok={Boolean(status?.keys.nebius)}
            what="Hosted Nebius models. Without this key, Nebius selections use scripted mock responses."
            href="https://tokenfactory.nebius.com"
          />
          <KeyRow name="Tavily" envVar="TAVILY_API_KEY" ok={Boolean(status?.keys.tavily)} what="Web search, page reading and site crawls." href="https://app.tavily.com" />
          <KeyRow
            name="Browserbase"
            envVar="BROWSERBASE_API_KEY"
            ok={Boolean(status?.keys.browserbase)}
            what="Cloud browsers for bots with the Browser tool. Watch them live and take over."
            href="https://www.browserbase.com"
          />
          <KeyRow
            name="Composio"
            envVar="COMPOSIO_API_KEY"
            ok={Boolean(status?.keys.composio)}
            what="Connected apps: Slack, GitHub, Gmail, Notion and 1,000+ more, with sign-in handled by Composio."
            href="https://platform.composio.dev"
          />
          <KeyRow
            name="Jev (TypeSafe)"
            envVar="TYPESAFE_API_KEY"
            ok={Boolean(status?.keys.jev)}
            what="Picks who answers in Auto rooms. Without it, the room's lead answers."
            href="https://typesafe.ai"
          />
        </ul>
      </section>
      <section className="mt-7">
        <h3 className="text-[12.5px] font-medium text-mute">Model providers</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-mute">
          Provider status is discovered by the server. Ollama credentials and endpoint settings stay in server environment variables.
        </p>
        <ul className="mt-3 divide-y divide-line rounded-2xl bg-raised">
          {state.modelProviders.map((provider) => (
            <li key={provider.providerId} className="px-4 py-3.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[14.5px] font-medium">{provider.label}</span>
                <span className={clsx("text-[12.5px]", provider.available ? "text-ok" : "text-faint")}>
                  {provider.available ? "Available" : provider.configured ? "Unavailable" : "Not configured"}
                </span>
              </div>
              {provider.message && <p className="mt-1 text-[12.5px] leading-snug text-mute">{provider.message}</p>}
              {provider.providerId === "ollama" && (
                <p className="mt-1 text-[12px] text-faint">
                  Set OLLAMA_BASE_URL on the server (defaults to localhost:11434); OLLAMA_API_KEY is optional.
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="mt-7">
        <h3 className="text-[12.5px] font-medium text-mute">Model usage</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-mute">
          New turns are recorded by provider and model. Providers that do not report token counts or pricing remain marked unknown.
        </p>
        {usageError && <p role="alert" className="mt-2 text-[12.5px] text-danger">{usageError}</p>}
        <ul className="mt-3 divide-y divide-line rounded-2xl bg-raised">
          {usage.map((row) => (
            <li key={`${row.provider}:${row.model}`} className="px-4 py-3.5">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[14px] font-medium">{row.provider} · {row.model}</span>
                <span className="shrink-0 text-[12px] text-faint">{row.requests} requests</span>
              </div>
              <p className="mt-1 text-[12.5px] text-mute">
                Input {row.inputTokens?.toLocaleString() ?? "unknown"}{row.unknownInputRequests > 0 ? ` (${row.unknownInputRequests} unknown)` : ""}
                {" · "}Output {row.outputTokens?.toLocaleString() ?? "unknown"}{row.unknownOutputRequests > 0 ? ` (${row.unknownOutputRequests} unknown)` : ""}
                {" · "}Cost {row.costUsd === null ? "unknown" : `$${row.costUsd.toFixed(4)}`}{row.unknownCostRequests > 0 ? ` (${row.unknownCostRequests} unknown)` : ""}
              </p>
              {(row.simulatedRequests > 0 || row.fallbackRequests > 0) && (
                <p className="mt-1 text-[12px] text-faint">
                  {row.simulatedRequests > 0 && `${row.simulatedRequests} simulated`}
                  {row.simulatedRequests > 0 && row.fallbackRequests > 0 ? " · " : ""}
                  {row.fallbackRequests > 0 && `${row.fallbackRequests} fallback`}
                </p>
              )}
            </li>
          ))}
          {!usage.length && !usageError && <li className="px-4 py-3.5 text-[13px] text-faint">No model usage recorded yet.</li>}
        </ul>
      </section>
      <ApprovalCenter />
      <ScheduledWorkflows />
      <section className="mt-7">
        <h3 className="text-[12.5px] font-medium text-mute">Data</h3>
        <p className="mt-1 text-[13px] text-mute">
          Bots, chats, private <code className="rounded-md bg-raised-2 px-1 font-mono text-[12px]">MEMORY.md</code> files and shared <code className="rounded-md bg-raised-2 px-1 font-mono text-[12px]">PROJECT_MEMORY.md</code> are stored locally in:
        </p>
        <p className="mt-2 rounded-2xl bg-raised px-4 py-3 font-mono text-[12px] break-all text-mute">{status?.dataDir}</p>
      </section>
    </Drawer>
  );
}
