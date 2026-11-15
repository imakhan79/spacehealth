import { Radiation } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CrewMember, Vital } from "@/lib/dashboard/types";
import { RADIATION, careerDoseTone, doseRateTone, latestRadiation, type Tone } from "@/lib/dashboard/vital-thresholds";
import { cn, timeAgo } from "@/lib/utils";
import { DrillButton, ShelterChecklist } from "./storm-drill";

// Meter fill carries severity; the track is a lighter step of the same colour.
const METER: Record<Tone, { fill: string; track: string; text: string }> = {
  normal: { fill: "bg-series", track: "bg-series/20", text: "text-foreground" },
  caution: { fill: "bg-caution", track: "bg-caution/20", text: "text-caution" },
  emergency: { fill: "bg-emergency", track: "bg-emergency/20", text: "text-emergency" },
};

const TONE_WORD: Record<Tone, string> = { normal: "", caution: " · caution", emergency: " · emergency" };

export function RadiationPanel({ crew, vitals, demoMode }: { crew: CrewMember[]; vitals: Vital[]; demoMode: boolean }) {
  const readings = latestRadiation(vitals);
  const shown = crew.filter((c) => readings.has(c.id));
  const now = Date.now();
  const peakRate = Math.max(0, ...shown.map((c) => readings.get(c.id)?.doseRate ?? 0));

  return (
    <section aria-labelledby="radiation-heading" className="flex flex-col gap-3">
      <h2 id="radiation-heading" className="text-lg font-semibold">
        Radiation dose
      </h2>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
            <Radiation className="size-4 text-info" aria-hidden />
            Career limit {RADIATION.careerLimitMsv} {RADIATION.cumulativeUnit} (NASA-STD-3001)
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {doseRateTone(peakRate) === "emergency" && <ShelterChecklist peak={peakRate} />}
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">No dosimeter readings yet.</p>
          ) : (
            shown.map((member) => {
              const r = readings.get(member.id)!;
              const share = r.cumulativeMsv === null ? null : r.cumulativeMsv / RADIATION.careerLimitMsv;
              const careerTone = r.cumulativeMsv === null ? "normal" : careerDoseTone(r.cumulativeMsv);
              const rateTone = r.doseRate === null ? "normal" : doseRateTone(r.doseRate);
              const pct = share === null ? null : Math.round(share * 100);
              return (
                <div key={member.id} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold">{member.callsign}</span>
                    <span className="text-xs text-muted-foreground">{timeAgo(r.at, now)}</span>
                  </div>
                  {r.cumulativeMsv !== null && pct !== null && (
                    <>
                      <div
                        role="meter"
                        aria-label={`${member.callsign} career radiation dose`}
                        aria-valuemin={0}
                        aria-valuemax={RADIATION.careerLimitMsv}
                        aria-valuenow={Number(r.cumulativeMsv.toFixed(1))}
                        aria-valuetext={`${r.cumulativeMsv.toFixed(1)} mSv, ${pct}% of the career limit`}
                        className={cn("h-2 w-full overflow-hidden rounded-full", METER[careerTone].track)}
                      >
                        <div className={cn("h-full rounded-full", METER[careerTone].fill)} style={{ width: `${Math.min(100, share! * 100)}%` }} />
                      </div>
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className={cn("font-semibold", METER[careerTone].text)}>
                          {r.cumulativeMsv.toFixed(1)}
                          <span className="ml-1 text-xs font-normal text-muted-foreground">{RADIATION.cumulativeUnit}</span>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {pct}% of career limit{TONE_WORD[careerTone]}
                        </span>
                      </div>
                    </>
                  )}
                  {r.doseRate !== null && (
                    <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                      <span>
                        Dose rate{" "}
                        <span className={cn("text-sm font-semibold", METER[rateTone].text)}>{Math.round(r.doseRate)}</span>{" "}
                        {RADIATION.doseRateUnit}
                        {TONE_WORD[rateTone]}
                      </span>
                      <span>≈ {((r.doseRate * 24) / 1000).toFixed(2)} mSv/day</span>
                    </div>
                  )}
                </div>
              );
            })
          )}
          {demoMode && <DrillButton />}
        </CardContent>
      </Card>
    </section>
  );
}
