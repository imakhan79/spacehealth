"use client";

import { LogOut } from "lucide-react";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { signOut } from "@/app/login/actions";
import { clearAll, readOutbox } from "@/lib/offline/store";

export function SignOutButton() {
  const [pending, startTransition] = useTransition();

  const onClick = (): void => {
    startTransition(async () => {
      const unsent = await readOutbox();
      if (unsent.length > 0 && !window.confirm(`${unsent.length} change(s) have not reached the station server yet and will be lost. Sign out anyway?`)) {
        return;
      }
      // Shared tablet: leave no health data or pending changes behind.
      await clearAll();
      await signOut();
    });
  };

  return (
    <Button variant="ghost" size="sm" onClick={onClick} disabled={pending} aria-label="Sign out">
      <LogOut aria-hidden />
      <span className="hidden sm:inline">Sign out</span>
    </Button>
  );
}
