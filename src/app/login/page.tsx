import { Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { demoLogin } from "@/lib/supabase/config";
import { LoginForm } from "./login-form";

// Reads the demo env per request, so it must not be prerendered at build time.
export const dynamic = "force-dynamic";

export default function LoginPage() {
  const demo = demoLogin();
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
