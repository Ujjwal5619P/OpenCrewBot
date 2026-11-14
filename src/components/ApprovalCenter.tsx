"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { timeLabel } from "@/lib/client/format";
import type { ApprovalRequest } from "@/lib/shared/types";
import { useApp } from "./OpenCrewBotApp";
import { Button } from "./ui";

export function ApprovalCenter() {
  const { state, toast } = useApp();
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.approvals();
      setRequests(result.requests);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't load approval history.");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const decide = async (request: ApprovalRequest, approve: boolean) => {
    setBusy(request.id);
    try {
      await api.approve(request.conversationId, request.botId, request.toolCallId, approve);
      await refresh();
      toast(approve ? "Action approved once." : "Action rejected; it will not run.");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't record that decision.");
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const botNames = new Map(state.bots.map((bot) => [bot.id, bot.name]));
  const pending = requests.filter((request) => request.status === "pending");
  return (
    <section className="mt-7">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[12.5px] font-medium text-mute">Approval centre</h3>
        <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading}>Refresh</Button>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-mute">
        Pending actions and recent decisions. Approval requests expire after 30 minutes and are cancelled safely if the server restarts.
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-faint">
        This app assumes one trusted local owner; it does not provide sign-in or multi-user identity.
      </p>
      {loading && requests.length === 0 && <p className="mt-3 text-[13px] text-mute">Loading approvals…</p>}
      {!loading && requests.length === 0 && <p className="mt-3 text-[13px] text-mute">No approval requests yet.</p>}
      {pending.length > 0 && <h4 className="mt-3 text-[12px] font-medium text-warn">Waiting for you</h4>}
      <div className="mt-2 space-y-2">
        {requests.map((request) => {
          const isPending = request.status === "pending";
          return (
            <article key={request.id} className="rounded-2xl bg-raised px-3.5 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium">{request.action || request.toolName}</p>
                  <p className="mt-0.5 text-[12px] text-mute">
                    {botNames.get(request.botId) ?? "Deleted agent"} · {request.toolName}
                  </p>
                  {request.executionId && (
                    <p className="mt-0.5 break-all text-[11px] text-faint">
                      Execution {request.executionId}{request.taskId ? ` · task ${request.taskId}` : ""}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-faint">
                    Requested {timeLabel(request.createdAt)}
                    {request.decidedAt ? ` · ${request.status} ${timeLabel(request.decidedAt)}` : ` · expires ${timeLabel(request.expiresAt)}`}
                  </p>
                </div>
                <span className={isPending ? "shrink-0 text-[11px] font-medium text-warn" : "shrink-0 text-[11px] text-faint"}>
                  {isPending ? "Pending" : request.status}
                </span>
              </div>
              <pre className="mt-2 max-h-40 overflow-auto rounded-xl bg-raised-2 p-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words text-mute">{request.details}</pre>
              {isPending && (
                <div className="mt-2 flex justify-end gap-2">
                  <Button size="sm" variant="secondary" disabled={busy === request.id} onClick={() => void decide(request, false)}>
                    Reject
                  </Button>
                  <Button size="sm" variant="primary" disabled={busy === request.id} onClick={() => void decide(request, true)}>
                    Approve once
                  </Button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
