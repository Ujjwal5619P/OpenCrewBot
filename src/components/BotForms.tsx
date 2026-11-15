"use client";

import clsx from "clsx";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client/api";
import type { Bot, BotInput, ModelSelection, ModelTaskType, SkillSummary } from "@/lib/shared/types";
import { useApp } from "./OpenCrewBotApp";
import { ModelPicker } from "./ModelPicker";
import { Button, Drawer, Field, Mascot, Segmented, Toggle, inputClass } from "./ui";
import { useConnections } from "@/lib/client/use-connections";

export const BOT_COLORS = ["#3b82f6", "#f59e0b", "#ec4899", "#22c55e", "#8b5cf6", "#14b8a6", "#ef4444", "#eab308", "#f4f4f4"];

const MODEL_TASKS: { id: ModelTaskType; label: string }[] = [
  { id: "general", label: "General conversation" },
  { id: "research", label: "Research" },
  { id: "coding", label: "Coding" },
  { id: "data_analysis", label: "Data analysis" },
  { id: "planning", label: "Planning" },
];

const modelKey = (selection?: ModelSelection | null) => selection ? `${selection.providerId}:${selection.model}` : "";

function blankBot(defaultModel: string): BotInput {
  return {
    name: "",
    title: "",
    description: "",
    instructions: "",
    emoji: "",
    color: BOT_COLORS[Math.floor(Math.random() * BOT_COLORS.length)],
    model: defaultModel,
    modelProvider: "nebius",
    tools: { webSearch: true, memory: true, codeMode: false, browser: false, askUser: true },
    approval: "ask",
    approvalPermissions: [],
    pinned: false,
  };
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap justify-center gap-2" role="radiogroup" aria-label="Color">
      {BOT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={`Color ${c}`}
          onClick={() => onChange(c)}
          className={clsx(
            "flex h-7 w-7 items-center justify-center rounded-full transition-transform hover:scale-110",
            value === c && "ring-2 ring-white ring-offset-2 ring-offset-side",
          )}
          style={{ background: c }}
        >
          {value === c && <Check size={14} className={c === "#f4f4f4" ? "text-black" : "text-white"} />}
        </button>
      ))}
    </div>
  );
}

/** Create or edit a bot. In edit mode the save bar appears only once something changes. */
export function BotForm({ bot, initialValue, onDone }: { bot?: Bot; initialValue?: BotInput; onDone?: (bot: Bot) => void }) {
  const { state, open, toast } = useApp();
  const defaultModel = state.models.find((m) => m.id === "MiniMaxAI/MiniMax-M3")?.id ?? state.models[0]?.id ?? "MiniMaxAI/MiniMax-M3";
  const { options: connectionOptions } = useConnections(state.connectionsVersion);
  const [initial, setInitial] = useState<BotInput>(() => (bot ? { ...bot } : initialValue ? { ...initialValue } : blankBot(defaultModel)));
  const [form, setForm] = useState<BotInput>(initial);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [skillCatalog, setSkillCatalog] = useState<SkillSummary[]>([]);
  const [skillLoadError, setSkillLoadError] = useState<string | null>(null);
  const keys = state.status?.keys;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const primarySelection = { providerId: form.modelProvider ?? "nebius", model: form.model } as const;
  const modelSupportsTools = state.models.find((model) => model.providerId === primarySelection.providerId && model.id === primarySelection.model)?.tools ?? false;
  const preferenceModels = state.models.filter((model) => model.available && (!Object.values(form.tools).some(Boolean) || model.tools));
  const availableSkillTools = new Set<string>();
  if (modelSupportsTools && form.tools.webSearch && keys?.tavily) {
    availableSkillTools.add("web_search");
    availableSkillTools.add("read_page");
  }
  if (modelSupportsTools && form.tools.codeMode) availableSkillTools.add("execute_typescript");
  if (
    modelSupportsTools &&
    keys?.composio &&
    (form.connections ?? []).some((id) => id.startsWith("composio:")) &&
    connectionOptions.some((option) => option.kind === "composio" && (form.connections ?? []).includes(option.id))
  ) {
    availableSkillTools.add("COMPOSIO_MULTI_EXECUTE_TOOL");
  }

  useEffect(() => {
    let cancelled = false;
    api
      .skills()
      .then(({ skills }) => {
        if (!cancelled) {
          setSkillCatalog(skills);
          setSkillLoadError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) setSkillLoadError(error instanceof Error ? error.message : "Couldn't load the skill library.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const set = <K extends keyof BotInput>(k: K, v: BotInput[K]) => {
    setErrorMessage(null);
    setForm((f) => ({ ...f, [k]: v }));
  };
  const setTool = (k: keyof BotInput["tools"], v: boolean) => {
    setErrorMessage(null);
    setForm((f) => ({ ...f, tools: { ...f.tools, [k]: v } }));
  };

  const save = async () => {
    setSaving(true);
    setErrorMessage(null);
    try {
      if (bot) {
        const { bot: saved } = await api.updateBot(bot.id, form);
        setInitial({ ...saved });
        setForm({ ...saved });
        toast("Saved. Changes apply from the next reply.");
        onDone?.(saved);
      } else {
        const { bot: created } = await api.createBot(form);
        open(`dm:${created.id}`);
        onDone?.(created);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't save.";
      setErrorMessage(message);
      toast(message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!bot || !window.confirm(`Delete ${bot.name}? Its chat and MEMORY.md are deleted too.`)) return;
    try {
      await api.deleteBot(bot.id);
      open(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't delete.");
    }
  };

  return (
    <div className="flex flex-col">
      <div className="space-y-5">
        {errorMessage && (
          <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger">
            {errorMessage}
          </p>
        )}
        {!bot && (
          <div className="flex flex-col items-center gap-4 pt-1">
            <Mascot color={form.color} size={72} />
            <ColorPicker value={form.color} onChange={(c) => set("color", c)} />
          </div>
        )}
        {bot && (
          <Field label="Color">
            <ColorPicker value={form.color} onChange={(c) => set("color", c)} />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input className={inputClass} value={form.name} maxLength={40} onChange={(e) => set("name", e.target.value)} placeholder="Scout" />
          </Field>
          <Field label="Role">
            <input className={inputClass} value={form.title} maxLength={40} onChange={(e) => set("title", e.target.value)} placeholder="Research" />
          </Field>
        </div>
        {bot && (
          <Field label="Handle" hint="For @mentions in rooms.">
            <div className="relative">
              <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[14px] text-faint">@</span>
              <input
                className={clsx(inputClass, "pl-7")}
                value={form.handle ?? bot.handle}
                onChange={(e) => set("handle", e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
              />
            </div>
          </Field>
        )}
        <Field label="What it's for" hint="One line. Rooms use it to decide who answers.">
          <input
            className={inputClass}
            value={form.description}
            maxLength={200}
            onChange={(e) => set("description", e.target.value)}
            placeholder="Finds things out on the web and comes back with sourced answers."
          />
        </Field>
        <Field label="Instructions" hint="How it should work and talk. Part of its system prompt.">
          <textarea
            className={clsx(inputClass, "min-h-28 resize-y leading-relaxed")}
            value={form.instructions}
            onChange={(e) => set("instructions", e.target.value)}
            placeholder="Research before answering anything time-sensitive. Cite the URLs you used."
          />
        </Field>

        <div>
          <span className="mb-1.5 block text-[12.5px] font-medium text-mute">Reusable skills</span>
          <p className="mb-2 text-[12px] leading-relaxed text-faint">
            Select skills this bot can load on demand. Skills provide guidance only; they never add tools or change approval permissions.
          </p>
          {skillLoadError && <p role="alert" className="mb-2 rounded-xl bg-danger-soft px-3 py-2 text-[12px] text-danger">{skillLoadError}</p>}
          <div className="divide-y divide-line rounded-2xl bg-raised px-4">
            {skillCatalog.map((skill) => {
              const missing = skill.requiredTools.filter((tool) => !availableSkillTools.has(tool));
              const requirement = skill.requiredTools.length ? `Requires: ${skill.requiredTools.join(", ")}.` : "No external tools required.";
              const status = missing.length ? `Not executable now; missing: ${missing.join(", ")}.` : "Executable with the current tool configuration.";
              return (
                <Toggle
                  key={skill.id}
                  label={skill.name}
                  hint={`${skill.description} ${requirement} ${status}`}
                  checked={(form.skillIds ?? []).includes(skill.id)}
                  onChange={(on) => {
                    const selected = new Set(form.skillIds ?? []);
                    if (on) selected.add(skill.id);
                    else selected.delete(skill.id);
                    set("skillIds", [...selected]);
                  }}
                />
              );
            })}
            {!skillCatalog.length && !skillLoadError && <p className="py-3 text-[12px] text-faint">Loading available skills…</p>}
          </div>
        </div>

        {/* Not a <label>: the picker holds buttons and its own search field. */}
        <div>
          <span className="mb-1.5 block text-[12.5px] font-medium text-mute">Model</span>
          <ModelPicker
            value={primarySelection}
            onChange={(selection) => {
              setErrorMessage(null);
              setForm((current) => ({ ...current, model: selection.model, modelProvider: selection.providerId }));
            }}
          />
          <span className="mt-1.5 block text-[12px] leading-snug text-faint">
            {!state.models.some((model) => model.available && model.providerId === primarySelection.providerId && model.id === primarySelection.model)
              ? form.fallbackModel
                ? "Primary model is unavailable; the configured fallback will be selected before the turn starts."
                : primarySelection.providerId === "nebius" && !keys?.nebius
                  ? "Mock mode: replies are scripted until NEBIUS_API_KEY is configured."
                : "This model is unavailable. Requests will fail clearly; no unavailable model is silently substituted."
              : primarySelection.providerId === "ollama"
                ? "Local Ollama model. Credentials and endpoint configuration remain on the server."
                : "Nebius Token Factory model."}
          </span>
          <details className="mt-3 rounded-2xl bg-raised px-4 py-3">
            <summary className="cursor-pointer text-[13px] font-medium text-ink">Routing and fallback</summary>
            <p className="mt-2 text-[12px] leading-relaxed text-faint">
              Task routes use only available models. The explicit fallback is selected before a turn starts; requests are never replayed on another model after tool activity.
            </p>
            <div className="mt-3">
              <Field label="Fallback model">
              <select
                className={inputClass}
                value={modelKey(form.fallbackModel)}
                onChange={(event) => {
                  const selected = preferenceModels.find((model) => `${model.providerId}:${model.id}` === event.target.value);
                  set("fallbackModel", selected ? { providerId: selected.providerId, model: selected.id } : null);
                }}
              >
                <option value="">No fallback</option>
                {preferenceModels.map((model) => (
                  <option key={`${model.providerId}:${model.id}`} value={`${model.providerId}:${model.id}`}>
                    {model.providerId === "nebius" ? "Nebius" : "Ollama"} · {model.label}
                  </option>
                ))}
              </select>
              </Field>
            </div>
            <div className="mt-3 space-y-3">
              {MODEL_TASKS.map((task) => (
                <Field key={task.id} label={`${task.label} model`}>
                  <select
                    className={inputClass}
                    value={modelKey(form.modelRouting?.[task.id])}
                    onChange={(event) => {
                      const selected = preferenceModels.find((model) => `${model.providerId}:${model.id}` === event.target.value);
                      setErrorMessage(null);
                      setForm((current) => {
                        const modelRouting = { ...current.modelRouting };
                        if (selected) modelRouting[task.id] = { providerId: selected.providerId, model: selected.id };
                        else delete modelRouting[task.id];
                        return { ...current, modelRouting };
                      });
                    }}
                  >
                    <option value="">Use default model</option>
                    {preferenceModels.map((model) => (
                      <option key={`${model.providerId}:${model.id}`} value={`${model.providerId}:${model.id}`}>
                        {model.providerId === "nebius" ? "Nebius" : "Ollama"} · {model.label}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
          </details>
        </div>

        <div>
          <span className="mb-1.5 block text-[12.5px] font-medium text-mute">Tools</span>
          <div className="divide-y divide-line rounded-2xl bg-raised px-4">
            <Toggle
              label="Web search"
              hint={keys?.tavily ? "Tavily search, page reading and site crawls." : "Tavily. Needs TAVILY_API_KEY."}
              checked={form.tools.webSearch}
              onChange={(v) => setTool("webSearch", v)}
            />
            <Toggle label="Memory" hint="Reads and updates its own MEMORY.md." checked={form.tools.memory} onChange={(v) => setTool("memory", v)} />
            <Toggle
              label="Code mode"
              hint="Writes one TypeScript function that calls several tools at once, in a sandbox."
              checked={form.tools.codeMode}
              onChange={(v) => setTool("codeMode", v)}
            />
            <Toggle
              label="Browser"
              hint={keys?.browserbase ? "A Browserbase cloud browser you can watch live." : "Browserbase. Needs BROWSERBASE_API_KEY."}
              checked={form.tools.browser}
              onChange={(v) => setTool("browser", v)}
            />
            <Toggle label="Ask me questions" hint="Can pause and ask you with a card in chat." checked={form.tools.askUser} onChange={(v) => setTool("askUser", v)} />
          </div>
        </div>

        <Field label="Approval">
          <Segmented
            value={form.approval}
            onChange={(v) => set("approval", v)}
            options={[
              { value: "ask", label: "Ask first", hint: "Sensitive actions wait for your OK." },
              { value: "controlled", label: "Controlled", hint: "Only listed safe tool IDs skip approval." },
              { value: "full", label: "Full access", hint: "Configured tools run without individual prompts." },
            ]}
          />
        </Field>
        {form.approval === "controlled" && (
          <Field label="Allowed action IDs" hint="Exact tool IDs only, one per line. Sensitive, connected-app, and MCP actions still ask. Unavailable tools have no effect.">
            <textarea
              className={clsx(inputClass, "min-h-20 resize-y font-mono text-[12px]")}
              value={(form.approvalPermissions ?? []).join("\n")}
              maxLength={12_000}
              onChange={(event) =>
                set(
                  "approvalPermissions",
                  [...new Set(event.target.value.split(/[\n,]/).map((value) => value.trim()).filter(Boolean))],
                )
              }
              placeholder="browser_goto"
            />
          </Field>
        )}

        {bot && (
          <div className="pt-2">
            <Button variant="danger" size="sm" onClick={remove}>
              Delete bot
            </Button>
          </div>
        )}
      </div>

      {(dirty || !bot) && (
        <div className="sticky bottom-0 -mx-5 mt-5 flex items-center justify-end gap-2 border-t border-line bg-side px-5 py-3">
          {bot && (
            <Button variant="ghost" onClick={() => setForm(initial)}>
              Discard
            </Button>
          )}
          <Button variant="primary" onClick={save} disabled={saving || !form.name.trim() || (bot && !dirty)}>
            {saving ? "Saving…" : bot ? "Save changes" : "Create bot"}
          </Button>
        </div>
      )}
    </div>
  );
}

export function NewBotDrawer({ onClose }: { onClose: () => void }) {
  return (
    <Drawer title="New bot" onClose={onClose}>
      <BotForm onDone={onClose} />
    </Drawer>
  );
}

/** The bot's MEMORY.md, editable, refreshed live when the bot writes to it. */
export function MemoryEditor({ bot }: { bot: Bot }) {
  const { state, toast } = useApp();
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [meta, setMeta] = useState<{ path: string; limit: { lines: number; bytes: number } } | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = content !== null && content !== saved;
  const version = state.memoryVersion[bot.id] ?? 0;

  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Load, and reload when the bot writes to its memory unless you have unsaved edits.
  useEffect(() => {
    if (dirtyRef.current) return;
    let cancelled = false;
    api
      .getMemory(bot.id)
      .then((data) => {
        if (cancelled) return;
        setSaved(data.content);
        setContent(data.content);
        setMeta({ path: data.path, limit: data.limit });
      })
      .catch((error) => toast(error instanceof Error ? error.message : "Couldn't load memory."));
    return () => {
      cancelled = true;
    };
  }, [bot.id, version, toast]);

  const save = async () => {
    if (content === null) return;
    setSaving(true);
    try {
      const data = await api.saveMemory(bot.id, content);
      setSaved(data.content);
      setContent(data.content);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't save memory.");
    } finally {
      setSaving(false);
    }
  };

  const lines = content ? content.trimEnd().split("\n").length : 0;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-center text-[13px] leading-relaxed text-mute">
        {bot.name} reads this at the start of every turn and keeps it up to date. It&apos;s plain Markdown, so edit away.
      </p>
      {!bot.tools.memory && (
        <p className="rounded-xl bg-warn-soft px-3.5 py-2.5 text-[13px] text-warn">Memory is off for this bot, so this file isn&apos;t loaded.</p>
      )}
      <textarea
        value={content ?? ""}
        onChange={(e) => setContent(e.target.value)}
        disabled={content === null}
        spellCheck={false}
        aria-label="MEMORY.md"
        className={clsx(inputClass, "h-[50vh] min-h-[240px] resize-y rounded-2xl p-4 font-mono text-[12.5px] leading-relaxed")}
      />
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[12px] text-faint" title={meta?.path}>
          MEMORY.md · {lines} {lines === 1 ? "line" : "lines"}
          {meta && lines > meta.limit.lines ? ` · first ${meta.limit.lines} load` : ""}
        </span>
        <span className="flex shrink-0 gap-2">
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => setContent(saved)}>
              Revert
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </span>
      </div>
    </div>
  );
}
