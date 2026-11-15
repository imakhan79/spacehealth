"use client";

import { LogIn, Rocket } from "lucide-react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { DemoLogin } from "@/lib/supabase/config";
import { signIn, signInDemo, type LoginState } from "./actions";

const initial: LoginState = { error: null };

export function LoginForm({ demo }: { demo: DemoLogin | null }) {
  const [state, action, pending] = useActionState(signIn, initial);
  const [demoState, demoAction, demoPending] = useActionState(signInDemo, initial);

  return (
    <div className="flex flex-col gap-5">
      {demo && (
        <form action={demoAction} className="flex flex-col gap-3 rounded-md border border-info/40 bg-info/10 p-3">
          <div className="text-sm">
            <p className="font-semibold">Demo account</p>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
              <dt>Email</dt>
              <dd className="font-mono break-all text-foreground">{demo.email}</dd>
              <dt>Password</dt>
              <dd className="font-mono break-all text-foreground">{demo.password}</dd>
            </dl>
          </div>
          {demoState.error && (
            <p role="alert" className="rounded-md border border-emergency/40 bg-emergency/10 px-3 py-2 text-sm text-emergency">
              {demoState.error}
            </p>
          )}
          <Button type="submit" size="lg" disabled={demoPending || pending}>
            <Rocket aria-hidden />
            {demoPending ? "Signing in…" : "Sign in as demo commander"}
          </Button>
        </form>
      )}
      <form action={action} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          Crew email
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            className="h-11 rounded-md border border-border bg-background px-3 text-base outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="h-11 rounded-md border border-border bg-background px-3 text-base outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        {state.error && (
          <p role="alert" className="rounded-md border border-emergency/40 bg-emergency/10 px-3 py-2 text-sm text-emergency">
            {state.error}
          </p>
        )}
        <Button type="submit" size="lg" disabled={pending}>
          <LogIn aria-hidden />
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
