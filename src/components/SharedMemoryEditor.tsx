"use client";

import clsx from "clsx";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/client/api";
import { useApp } from "./OpenCrewBotApp";
import { Button, Field, Toggle, inputClass } from "./ui";

type ProvenanceSource = "user" | "project_decision";
type Confidence = "confirmed" | "unverified";

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function SharedMemoryEditor() {
  const { state, toast } = useApp();
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [path, setPath] = useState("");
  const [limit, setLimit] = useState<{ bytes: number; readBytes: number } | null>(null);
  const [authorizedBotIds, setAuthorizedBotIds] = useState<string[]>([]);
  const [savedAuthorizedBotIds, setSavedAuthorizedBotIds] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [section, setSection] = useState("");
  const [source, setSource] = useState<ProvenanceSource>("user");
  const [confidence, setConfidence] = useState<Confidence>("unverified");
  const [savingContent, setSavingContent] = useState(false);
  const [savingAccess, setSavingAccess] = useState(false);
  const [addingEntry, setAddingEntry] = useState(false);
  const contentDirty = content !== null && content !== saved;
  const accessDirty = !sameIds(authorizedBotIds, savedAuthorizedBotIds);
  const dirty = contentDirty || accessDirty;
  const dirtyRef = useRef(dirty);
  const version = state.projectMemoryVersion;

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    if (dirtyRef.current) return;
    let cancelled = false;
    api.getProjectMemory().then((data) => {
      if (cancelled) return;
      setContent(data.content);
      setSaved(data.content);
      setPath(data.path);
      setLimit(data.limit);
      setAuthorizedBotIds(data.authorizedBotIds);
      setSavedAuthorizedBotIds(data.authorizedBotIds);
    }).catch((error) => toast(error instanceof Error ? error.message : "Couldn't load shared project memory."));
    return () => {
      cancelled = true;
    };
  }, [toast, version]);

  const saveContent = async () => {
    if (content === null) return;
    setSavingContent(true);
    try {
      const result = await api.saveProjectMemory(content);
      setContent(result.content);
      setSaved(result.content);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't save shared project memory.");
    } finally {
      setSavingContent(false);
    }
  };

  const saveAccess = async () => {
    setSavingAccess(true);
    try {
      const result = await api.setProjectMemoryAccess(authorizedBotIds, savedAuthorizedBotIds);
      setAuthorizedBotIds(result.authorizedBotIds);
      setSavedAuthorizedBotIds(result.authorizedBotIds);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't update project memory access.";
      if (message.startsWith("Project memory access changed elsewhere.")) {
        try {
          const current = await api.getProjectMemory();
          setAuthorizedBotIds(current.authorizedBotIds);
          setSavedAuthorizedBotIds(current.authorizedBotIds);
          toast("Access list refreshed; your stale changes were discarded. Review and apply them again if needed.");
        } catch {
          toast(message);
        }
      } else {
        toast(message);
      }
    } finally {
      setSavingAccess(false);
    }
  };

  const addEntry = async (event: FormEvent) => {
    event.preventDefault();
    if (!note.trim() || dirty) return;
    setAddingEntry(true);
    try {
      const result = await api.addProjectMemoryEntry({
        note,
        section: section.trim() || undefined,
        source,
        confidence,
      });
      setContent(result.content);
      setSaved(result.content);
      setNote("");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't add the project memory entry.");
    } finally {
      setAddingEntry(false);
    }
  };

  const lines = content ? content.trimEnd().split("\n").length : 0;
  return (
    <div className="space-y-4">
      <p className="text-center text-[13px] leading-relaxed text-mute">
        Shared Markdown for this project. Agents receive it only when explicitly authorized and when they read it with their project-memory tool.
      </p>

      <section className="rounded-2xl bg-raised px-4 py-3.5">
        <h3 className="text-[12.5px] font-medium text-faint">Agent access</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-mute">
          Access is off by default. Authorized agents can read and add notes; agent-added entries are always marked unverified.
          Revoking access starts a fresh model-side thread for future turns, but cannot undo disclosure in an in-flight turn or erase prior processing.
        </p>
        {state.bots.length === 0 && <p className="mt-3 text-[13px] text-mute">Create an agent before granting access.</p>}
        <div className="mt-2 divide-y divide-line">
          {state.bots.map((bot) => (
            <Toggle
              key={bot.id}
              label={bot.name}
              hint={bot.title || bot.description || "AI agent"}
              checked={authorizedBotIds.includes(bot.id)}
              disabled={content === null || savingAccess}
              onChange={(on) => setAuthorizedBotIds((current) =>
                on ? [...current, bot.id] : current.filter((id) => id !== bot.id),
              )}
            />
          ))}
        </div>
        <div className="mt-2 flex justify-end">
          <Button size="sm" variant="primary" disabled={!accessDirty || savingAccess} onClick={() => void saveAccess()}>
            {savingAccess ? "Saving access…" : "Save access"}
          </Button>
        </div>
      </section>

      <section className="rounded-2xl bg-raised px-4 py-3.5">
        <h3 className="text-[12.5px] font-medium text-faint">Add an attributed entry</h3>
        <form className="mt-2 space-y-3" onSubmit={(event) => void addEntry(event)}>
          <Field label="Note">
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={4_000}
              rows={3}
              className={inputClass}
              placeholder="A durable project fact, decision, or open question"
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Source">
              <select value={source} onChange={(event) => setSource(event.target.value as ProvenanceSource)} className={inputClass}>
                <option value="user">User-provided</option>
                <option value="project_decision">Project decision</option>
              </select>
            </Field>
            <Field label="Confidence">
              <select value={confidence} onChange={(event) => setConfidence(event.target.value as Confidence)} className={inputClass}>
                <option value="unverified">Unverified</option>
                <option value="confirmed">Confirmed</option>
              </select>
            </Field>
          </div>
          <Field label="Section" hint="Optional. The entry is timestamped and its provenance is recorded automatically.">
            <input value={section} onChange={(event) => setSection(event.target.value)} maxLength={80} className={inputClass} placeholder="Project decisions" />
          </Field>
          {dirty && <p className="text-[12px] text-warn">Save or revert your Markdown edits before adding an entry.</p>}
          <div className="flex justify-end">
            <Button size="sm" disabled={!note.trim() || dirty || addingEntry} type="submit">
              {addingEntry ? "Adding…" : "Add entry"}
            </Button>
          </div>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-[12.5px] font-medium text-faint">Project memory Markdown</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-mute">
            Edit the file directly. Direct edits are not auto-attributed; use the entry form to record provenance. Do not copy private agent notes here unless they are meant to be shared.
          </p>
        </div>
        <textarea
          value={content ?? ""}
          onChange={(event) => setContent(event.target.value)}
          disabled={content === null || savingContent}
          spellCheck={false}
          aria-label="PROJECT_MEMORY.md"
          className={clsx(inputClass, "h-[38vh] min-h-[220px] resize-y rounded-2xl p-4 font-mono text-[12.5px] leading-relaxed")}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[12px] text-faint" title={path}>
            PROJECT_MEMORY.md · {lines} {lines === 1 ? "line" : "lines"}
            {limit && ` · ${limit.bytes} byte limit`}
          </span>
          <span className="flex shrink-0 gap-2">
            {contentDirty && (
              <Button size="sm" variant="ghost" onClick={() => setContent(saved)}>
                Revert
              </Button>
            )}
            <Button size="sm" variant="primary" disabled={!contentDirty || savingContent} onClick={() => void saveContent()}>
              {savingContent ? "Saving…" : "Save"}
            </Button>
          </span>
        </div>
      </section>
    </div>
  );
}
