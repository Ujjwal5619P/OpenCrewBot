"use client";

import { Check, ExternalLink, RefreshCw, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { timeLabel } from "@/lib/client/format";
import type { PendingApproval } from "@/lib/shared/types";
import { useApp } from "./OpenCrewBotApp";
import { Button, Drawer } from "./ui";

export function ApprovalsPanel({ onClose }: { onClose: () => void }) {
  const { state, open, toast } = useApp();
  const [items, setItems] = useState<PendingApproval[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.approvals();
      setItems(data.approvals);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't load pending approvals.");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    api
      .approvals()
      .then((data) => {
        if (!cancelled) setItems(data.approvals);
      })
      .catch((error) => {
        if (!cancelled) toast(error instanceof Error ? error.message : "Couldn't load pending approvals.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [toast, state.approvalsVersion]);

  const decide = async (item: PendingApproval, approve: boolean) => {
    setBusyId(item.toolCallId);
    try {
      await api.approve(item.conversationId, item.botId, item.toolCallId, approve);
      toast(approve ? `Approved ${item.label} for ${item.botName}.` : `Rejected ${item.label}. Action blocked from executing.`);
      await load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Failed to submit decision.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Drawer title="Approval Centre" onClose={onClose}>
      <p className="rounded-2xl bg-raised px-3.5 py-2.5 text-[12.5px] leading-relaxed text-mute">
        Actions requiring human confirmation appear here. Rejecting an action permanently blocks that tool call from executing.
      </p>

      <div className="mt-5 mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[12.5px] font-medium text-mute">
          <ShieldAlert size={13} /> Pending approvals ({items.length})
        </h3>
        <button onClick={() => void load()} className="inline-flex items-center gap-1 text-[12px] text-faint hover:text-ink">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {loading && <p className="rounded-2xl bg-raised px-4 py-4 text-[13px] text-mute">Loading…</p>}

      {!loading && items.length === 0 && (
        <div className="rounded-2xl bg-raised px-4 py-6 text-center">
          <p className="text-[13.5px] font-medium">No pending approvals</p>
          <p className="mt-1 text-[12.5px] text-mute">
            Bots set to <strong>Ask first</strong> will pause here before running browser or MCP mutations.
          </p>
        </div>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-line rounded-2xl bg-raised">
          {items.map((item) => (
            <li key={`${item.conversationId}:${item.toolCallId}`} className="space-y-2.5 px-4 py-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-ink">{item.label}</p>
                  <p className="text-[12px] text-mute">
                    {item.botName} · <code className="rounded bg-raised-2 px-1 py-0.5 font-mono text-[11px]">{item.name}</code> ·{" "}
                    {timeLabel(item.createdAt)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    open(item.conversationId);
                    onClose();
                  }}
                  className="inline-flex shrink-0 items-center gap-1 text-[12px] text-[#8db4ff] hover:underline"
                >
                  Open chat <ExternalLink size={11} />
                </button>
              </div>
              {item.detail && <p className="rounded-xl bg-raised-2 px-3 py-2 text-[12.5px] break-all text-mute">{item.detail}</p>}
              <div className="flex items-center justify-end gap-2">
                <Button size="sm" variant="danger" disabled={busyId === item.toolCallId} onClick={() => void decide(item, false)}>
                  <X size={13} /> Reject
                </Button>
                <Button size="sm" variant="primary" disabled={busyId === item.toolCallId || !item.live} onClick={() => void decide(item, true)}>
                  <Check size={13} /> Approve once
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
