import { Activity } from "lucide-react";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { demoLogin } from "@/lib/supabase/config";
import { LoginForm } from "./login-form";

// Reads the demo env per request, so it must not be prerendered at build time.
export const dynamic = "force-dynamic";

export default function LoginPage() {
  const demo = demoLogin();
  // Ground demo: no login page at all; the dashboard signs the visitor in.
  if (demo) redirect("/dashboard");
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="pb-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Activity className="size-5 text-info" aria-hidden />
            <span className="text-sm font-semibold tracking-widest">OMNI</span>
          </div>
          <CardTitle className="text-xl">Crew sign in</CardTitle>
          <p className="text-sm text-muted-foreground">
            Authenticated aboard by the spacecraft server. Works with no Earth link.
          </p>
        </CardHeader>
        <CardContent>
          <LoginForm demo={demo} />
        </CardContent>
      </Card>
    </main>
  );
}
