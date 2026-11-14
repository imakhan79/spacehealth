"use client";

import { LogIn } from "lucide-react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { signIn, type LoginState } from "./actions";

const initial: LoginState = { error: null };

export function LoginForm() {
  const [state, action, pending] = useActionState(signIn, initial);

  return (
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
  );
}
