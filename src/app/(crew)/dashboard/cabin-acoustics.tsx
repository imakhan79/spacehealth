import { AudioLines } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AcousticWindow } from "@/lib/dashboard/types";
import { timeAgo } from "@/lib/utils";

export function CabinAcoustics({ windows }: { windows: AcousticWindow[] }) {
  // Newest first; keep the latest window per module.
  const latest = new Map<string, AcousticWindow>();
  for (const w of windows) if (!latest.has(w.module_id)) latest.set(w.module_id, w);

  return (
    <section aria-labelledby="acoustics-heading" className="flex flex-col gap-3">
      <h2 id="acoustics-heading" className="text-lg font-semibold">
        Cabin acoustics
      </h2>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm text-muted-foreground">
            <AudioLines className="size-4" aria-hidden /> Latest LAeq per module
          </CardTitle>
        </CardHeader>
        <CardContent>
          {latest.size === 0 ? (
            <p className="text-sm text-muted-foreground">No readings yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {[...latest.values()].map((w) => (
                <li key={w.module_id} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <div className="font-medium">{w.module_id}</div>
                    <div className="text-xs text-muted-foreground">{timeAgo(w.window_start)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-semibold tabular-nums">
                      {w.laeq_dba.toFixed(1)}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">dBA</span>
                    </span>
                    {w.limit_exceeded && <Badge variant="warning">Limit</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
