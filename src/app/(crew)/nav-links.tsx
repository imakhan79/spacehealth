"use client";

import { Activity, ClipboardList, Container, HeartHandshake, History, LayoutDashboard, Map as MapIcon, Moon, Orbit, Siren, Utensils } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/monitor", label: "ECG", icon: Activity },
  { href: "/eva", label: "EVA", icon: Orbit },
  { href: "/care", label: "Care", icon: HeartHandshake },
  { href: "/sleep", label: "Sleep", icon: Moon },
  { href: "/nutrition", label: "Nutrition", icon: Utensils },
  { href: "/habitat", label: "Habitat", icon: MapIcon },
  { href: "/supplies", label: "Supplies", icon: Container },
  { href: "/procedures", label: "Procedures", icon: Siren },
  { href: "/timeline", label: "Timeline", icon: History },
  { href: "/handover", label: "Handover", icon: ClipboardList },
] as const;

/** Section tabs; the current page is marked for screen readers and visually. */
export function NavLinks() {
  const path = usePathname();
  return (
    <nav aria-label="Sections" className="-mb-px flex gap-1 overflow-x-auto">
      {LINKS.map(({ href, label, icon: Icon }) => {
        const active = path === href || path.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm transition-colors",
              active ? "border-info font-semibold text-foreground" : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
          >
            <Icon className={cn("size-4", active && "text-info")} aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
