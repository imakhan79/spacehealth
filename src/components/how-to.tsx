"use client";

import { CircleHelp } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { GUIDES, type HelpPage } from "@/lib/help";

const KEY = "omni:help-closed:";

/**
 * Collapsible "How to use this page". Open on a first visit; once closed, it
 * stays closed for that page on this device (a per-viewer convenience).
 */
export function HowTo({ page }: { page: HelpPage }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const g = GUIDES[page];

  // Server and first client render are both open; apply the saved choice after.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(KEY + page) === "1" && ref.current) ref.current.open = false;
    } catch {
      // Storage unavailable: stay open.
    }
  }, [page]);

  return (
    <details
      ref={ref}
      open
      onToggle={(e) => {
        try {
          window.localStorage.setItem(KEY + page, (e.currentTarget as HTMLDetailsElement).open ? "0" : "1");
        } catch {
          // Not remembered; harmless.
        }
      }}
      className="group rounded-xl border border-info/30 bg-info/5 text-sm print:hidden"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 font-medium text-info [&::-webkit-details-marker]:hidden">
        <CircleHelp className="size-4 shrink-0" aria-hidden />
        How to use this page
        <span className="ml-auto text-xs font-normal text-muted-foreground group-open:hidden">Show</span>
        <span className="ml-auto hidden text-xs font-normal text-muted-foreground group-open:inline">Hide</span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-info/20 px-4 pb-4 pt-3">
        <p className="text-muted-foreground">{g.summary}</p>
        <ol className="flex list-decimal flex-col gap-1.5 pl-5 marker:text-info">
          {g.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <Link href="/help" className="self-start text-xs text-info hover:underline">
          All guides →
        </Link>
      </div>
    </details>
  );
}
