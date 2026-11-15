"use client";

import { Check, Mail, MailOpen, Satellite } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useConnectivity } from "@/components/connectivity-provider";
import type { CrewMember, Me } from "@/lib/dashboard/types";
import type { Tables } from "@/types/database.types";
import { cn, timeAgo } from "@/lib/utils";

type Message = Tables<"ground_messages"> & { ground_message_reads: Pick<Tables<"ground_message_reads">, "crew_member_id" | "read_at">[] };

const REFRESH_MS = 30_000;

export function MessagesPanel({ crewById, me }: { crewById: Map<string, CrewMember>; me: Me | null }) {
  const { client } = useConnectivity();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (): Promise<void> => {
    if (client === null) return;
    const res = await client
      .from("ground_messages")
      .select("id, author, priority, recipient_crew_id, subject, body, sent_at, received_at, ground_message_reads(crew_member_id, read_at)")
      .order("received_at", { ascending: false })
      .limit(30);
    setNow(Date.now());
    if (res.error) {
      setError("Station server not responding; showing the last messages loaded.");
      return;
    }
    setError(null);
    setMessages(res.data as Message[]);
  }, [client]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const markRead = useCallback(
    async (id: string): Promise<void> => {
      if (client === null) return;
      setMarking((s) => new Set(s).add(id));
      // The server stamps who and when; a repeat read is ignored.
      const res = await client.from("ground_message_reads").upsert({ message_id: id }, { onConflict: "message_id,crew_member_id", ignoreDuplicates: true });
      if (res.error) setError("Couldn't mark as read. Check the station connection and try again.");
      await load();
      setMarking((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    },
    [client, load],
  );

  if (messages === null && error === null) return null;

  const mine = (m: Message) => m.ground_message_reads.find((r) => r.crew_member_id === me?.crewMemberId);
  const unread = (messages ?? []).filter((m) => !mine(m)).length;
  const oversight = me?.role === "flight_surgeon" || me?.role === "commander";

  return (
    <section aria-labelledby="messages-heading" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 id="messages-heading" className="flex items-center gap-2 text-lg font-semibold">
          <Satellite className="size-4 text-info" aria-hidden />
          Messages from Mission Control
        </h2>
        <span className="text-sm text-muted-foreground">{unread === 0 ? "All read" : `${unread} unread`}</span>
      </div>
      {error && <p className="text-sm text-caution">{error}</p>}
      {messages !== null && messages.length === 0 ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">No messages received.</CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {(messages ?? []).map((m) => {
            const read = mine(m);
            const expanded = open.has(m.id) || !read;
            const to = m.recipient_crew_id ? (crewById.get(m.recipient_crew_id)?.callsign ?? "one crew member") : "all crew";
            const others = m.ground_message_reads.filter((r) => r.crew_member_id !== me?.crewMemberId);
            return (
              <li key={m.id}>
                <Card className={cn(!read && (m.priority === "urgent" ? "border-warning/60" : "border-info/50"))}>
                  <CardContent className="flex flex-col gap-2 p-4">
                    <button
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-left"
                      aria-expanded={expanded}
                      onClick={() =>
                        setOpen((s) => {
                          const next = new Set(s);
                          if (next.has(m.id)) next.delete(m.id);
                          else next.add(m.id);
                          return next;
                        })
                      }
                    >
                      {read ? <MailOpen className="size-4 text-muted-foreground" aria-hidden /> : <Mail className="size-4 text-info" aria-hidden />}
                      {!read && <span className="sr-only">Unread: </span>}
                      {m.priority === "urgent" && <Badge variant="warning">Urgent</Badge>}
                      <span className={cn("font-semibold", read && "font-normal text-muted-foreground")}>{m.subject}</span>
                      <span className="text-xs text-muted-foreground">
                        {m.author} · to {to} · {timeAgo(m.sent_at, now)}
                      </span>
                    </button>
                    {expanded && <p className="whitespace-pre-line text-sm">{m.body}</p>}
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      {read ? (
                        <span className="flex items-center gap-1">
                          <Check className="size-3.5 text-ok" aria-hidden /> Read {timeAgo(read.read_at, now)}
                        </span>
                      ) : (
                        <Button size="sm" variant="outline" disabled={marking.has(m.id) || me?.crewMemberId == null} onClick={() => void markRead(m.id)}>
                          <Check aria-hidden /> {marking.has(m.id) ? "Marking…" : "Mark read"}
                        </Button>
                      )}
                      {oversight && others.length > 0 && (
                        <span>Also read by {others.map((r) => crewById.get(r.crew_member_id)?.callsign ?? "crew").join(", ")}</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
