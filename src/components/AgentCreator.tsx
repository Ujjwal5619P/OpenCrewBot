"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/client/api";
import type { AgentConfigurationResult } from "@/lib/shared/types";
import { useApp } from "./OpenCrewBotApp";
import { BotForm } from "./BotForms";
import { Button, Drawer, Field, inputClass } from "./ui";

const toolLabels: Record<keyof AgentConfigurationResult["configuration"]["tools"], string> = {
  webSearch: "Web search",
  memory: "Private memory",
  codeMode: "Code mode",
  browser: "Browser",
  askUser: "Ask questions",
};

export function AgentCreator({ onClose }: { onClose: () => void }) {
  const { toast } = useApp();
  const [description, setDescription] = useState("");
  const [result, setResult] = useState<AgentConfigurationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [reviewKey, setReviewKey] = useState(0);
  const enabledTools = (Object.keys(toolLabels) as (keyof typeof toolLabels)[]).filter((key) => result?.configuration.tools[key]);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const generated = await api.generateAgent(description);
      setResult(generated);
      setReviewKey((key) => key + 1);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Couldn't generate an agent configuration.";
      setError(message);
      toast(message);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Drawer title="Create Agent with AI" onClose={onClose}>
      <div className="space-y-5">
        {!result ? (
          <>
            <p className="text-[13px] leading-relaxed text-mute">
              Describe the specialist you need. The generated setup is a draft; review and edit it before creating the agent.
            </p>
            <Field label="What should this agent do?" hint="Be specific about its role, tools, working style, and expected results.">
              <textarea
                autoFocus
                value={description}
                maxLength={20_000}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Create a cybersecurity research agent that analyses web vulnerabilities, uses web search and code analysis, remembers findings, and produces structured security reports."
                className={`${inputClass} min-h-36 resize-y leading-relaxed`}
              />
            </Field>
            {error && (
              <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger">
                {error}
              </p>
            )}
            <Button variant="primary" onClick={generate} disabled={generating || !description.trim()} className="w-full">
              <Sparkles size={15} />
              {generating ? "Generating…" : "Generate configuration"}
            </Button>
          </>
        ) : (
          <>
            <section className="space-y-3 rounded-2xl bg-raised p-4 ring-1 ring-line">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-accent">{result.label}</p>
                <h3 className="mt-1 text-[16px] font-semibold">{result.configuration.name}</h3>
                <p className="text-[13px] text-mute">{result.configuration.title} · {result.configuration.description}</p>
              </div>
              <div>
                <p className="text-[12px] font-medium text-mute">Suggested skills (instruction guidance)</p>
                <p className="mt-1 text-[13px] text-ink">{result.configuration.skills.join(" · ")}</p>
              </div>
              <div>
                <p className="text-[12px] font-medium text-mute">Tools</p>
                <p className="mt-1 text-[13px] text-ink">
                  {enabledTools.map((key) => toolLabels[key]).join(" · ") || "None"}
                </p>
              </div>
              <p className="text-[12.5px] text-mute">
                Memory: {result.configuration.memory.enabled ? "enabled with a private MEMORY.md" : "disabled"} · External actions: Ask first
              </p>
              <div>
                <p className="text-[12px] font-medium text-mute">Expected output</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink">{result.configuration.expectedOutputFormat}</p>
              </div>
              <p className="text-[12px] leading-relaxed text-faint">
                Suggested skills and output format are editable prompt guidance. You can also assign reusable library skills below; those do not install tools or integrations.
              </p>
              {result.unavailableTools.length > 0 && (
                <p role="status" className="rounded-xl bg-warn-soft px-3 py-2 text-[12px] text-warn">
                  Disabled because this server is not configured for them: {result.unavailableTools.map((tool) => toolLabels[tool]).join(", ")}.
                </p>
              )}
            </section>
            <p className="text-center text-[12px] font-medium text-mute">Review and edit every field below before creating.</p>
            <BotForm key={reviewKey} initialValue={result.botInput} onDone={onClose} />
          </>
        )}
      </div>
    </Drawer>
  );
}
