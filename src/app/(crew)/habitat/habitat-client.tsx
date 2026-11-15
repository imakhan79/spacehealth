"use client";

import { Map as MapIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { useConnectivity } from "@/components/connectivity-provider";
import type { Me } from "@/lib/dashboard/types";
import { doseRateTone } from "@/lib/dashboard/vital-thresholds";
import { DOSE_EDGES, HATCHES, MODULES, NOISE_EDGES, binOf } from "@/lib/habitat";
import { CO2_EDGES, assessAir, type AirReading } from "@/lib/air";
import type { Tables } from "@/types/database.types";
import { Ago } from "@/lib/use-now";
import { cn } from "@/lib/utils";

type Layer = "noise" | "radiation" | "air";
interface HabitatData {
  crew: Pick<Tables<"crew_members">, "id" | "callsign">[];
  locations: Tables<"crew_locations">[];
  noise: Map<string, { laeq: number; limit: boolean; at: string }>;
  dose: Map<string, { rate: number; at: string }>; // per crew member
  air: Map<string, AirReading & { at: string }>;
}

const REFRESH_MS = 15_000;
// Sequential: one hue, five steps from faint to strong (see dataviz rules).
const STEP_OPACITY = [0.12, 0.24, 0.38, 0.56, 0.8] as const;

export function HabitatClient({ me }: { me: Me | null }) {
  const { client } = useConnectivity();
  const [data, setData] = useState<HabitatData | null>(null);
  const [layer, setLayer] = useState<Layer>("noise");
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (client === null) return;
    const [crew, locations, acoustics, dose, air] = await Promise.all([
      client.from("crew_members").select("id, callsign").eq("is_active", true).neq("role", "sensor_gateway").order("callsign"),
      client.from("crew_locations").select("*"),
      client.from("ambient_acoustics").select("module_id, laeq_dba, limit_exceeded, window_start").order("window_start", { ascending: false }).limit(60),
      client
        .from("crew_telemetry")
        .select("crew_member_id, value, recorded_at")
        .eq("metric", "radiation_dose_rate")
        .gte("recorded_at", new Date(Date.now() - 30 * 60_000).toISOString())
        .order("recorded_at", { ascending: false })
        .limit(200),
      client.from("cabin_air").select("module_id, co2_ppm, o2_pct, humidity_pct, temp_c, window_start").order("window_start", { ascending: false }).limit(80),
    ]);
    if ([crew, locations, acoustics, dose, air].some((r) => r.error)) {
      setError("Station server not responding; showing the last data loaded.");
      return;
    }
    setError(null);
    const noise = new Map<string, { laeq: number; limit: boolean; at: string }>();
    for (const a of acoustics.data ?? []) if (!noise.has(a.module_id)) noise.set(a.module_id, { laeq: a.laeq_dba, limit: a.limit_exceeded, at: a.window_start });
    const doseBy = new Map<string, { rate: number; at: string }>();
    for (const d of dose.data ?? []) if (!doseBy.has(d.crew_member_id)) doseBy.set(d.crew_member_id, { rate: d.value, at: d.recorded_at });
    const airBy = new Map<string, AirReading & { at: string }>();
    for (const a of air.data ?? []) if (!airBy.has(a.module_id)) airBy.set(a.module_id, { ...a, at: a.window_start });
    setData({ crew: crew.data ?? [], locations: locations.data ?? [], noise, dose: doseBy, air: airBy });
  }, [client]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const callsign = useMemo(() => new Map((data?.crew ?? []).map((c) => [c.id, c.callsign])), [data]);
  const myModule = data?.locations.find((l) => l.crew_member_id === me?.crewMemberId)?.module_id ?? "";

  async function moveTo(moduleId: string): Promise<void> {
    if (client === null || !moduleId) return;
    const res = await client.from("crew_locations").upsert({ module_id: moduleId }, { onConflict: "crew_member_id" });
    if (res.error) setError(`Couldn't update your location: ${res.error.message}`);
    await load();
  }

  // Per-module values for the active layer.
  const rows = MODULES.map((m) => {
    const here = (data?.locations ?? []).filter((l) => l.module_id === m.id).map((l) => l.crew_member_id);
    const n = data?.noise.get(m.id) ?? null;
    const rates = here.map((id) => data?.dose.get(id)?.rate).filter((r): r is number => r !== undefined);
    const rate = rates.length ? Math.max(...rates) : null;
    const airNow = data?.air.get(m.id) ?? null;
    return { m, here, noise: n, rate, air: airNow, airCheck: airNow ? assessAir(airNow) : null };
  });

  const valueOf = (r: (typeof rows)[number]) => (layer === "noise" ? (r.noise?.laeq ?? null) : layer === "air" ? (r.air?.co2_ppm ?? null) : r.rate);
  const flagOf = (r: (typeof rows)[number]): string | null => {
    if (layer === "noise") return r.noise?.limit ? "Over limit" : null;
    if (layer === "air") return r.airCheck?.tone === "emergency" ? "Ventilate now" : r.airCheck?.tone === "caution" ? "Check air" : null;
    if (r.rate === null) return null;
    const t = doseRateTone(r.rate);
    return t === "emergency" ? "Shelter now" : t === "caution" ? "Elevated" : null;
  };
  const fmt = (r: (typeof rows)[number]) => {
    const v = valueOf(r);
    if (v === null) return layer === "noise" ? (r.m.acoustic ? "no reading" : "no sensor") : layer === "air" ? "no sensor" : "—";
    if (layer === "air") return `${Math.round(v).toLocaleString("en-US")} ppm CO₂`;
    return layer === "noise" ? `${v.toFixed(1)} dBA` : `${Math.round(v).toLocaleString("en-US")} µSv/h`;
  };
  const edges = layer === "noise" ? NOISE_EDGES : layer === "air" ? CO2_EDGES : DOSE_EDGES;
  const centre = (id: string) => {
    const m = MODULES.find((x) => x.id === id)!;
    return { x: m.x + m.w / 2, y: m.y + m.h / 2 };
  };

  return (
    <div className="flex flex-col gap-4">
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <MapIcon className="size-6 text-info" aria-hidden /> Habitat
      </h1>

      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="Map layer" className="flex rounded-md border border-border p-0.5">
          {(["noise", "air", "radiation"] as const).map((l) => (
            <button
              key={l}
              role="radio"
              aria-checked={layer === l}
              onClick={() => setLayer(l)}
              className={cn("h-8 rounded px-3 text-sm", layer === l ? "bg-muted font-semibold" : "text-muted-foreground hover:text-foreground")}
            >
              {l === "noise" ? "Noise (LAeq)" : l === "air" ? "Air (CO₂)" : "Radiation (dose rate)"}
            </button>
          ))}
        </div>
        {me?.crewMemberId && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">You are in</span>
            <select value={myModule} onChange={(e) => void moveTo(e.target.value)} className="h-9 rounded-md border border-border bg-background px-2">
              <option value="" disabled>
                choose module…
              </option>
              {MODULES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error && <p className="text-sm text-caution">{error}</p>}

      <Card>
        <CardContent className="p-3">
          <div className="overflow-x-auto">
            <svg viewBox="0 0 1000 330" className="h-auto w-full min-w-[640px]" role="img" aria-label={`Habitat map, ${layer} layer. Details in the table below.`}>
              {HATCHES.map(([a, b]) => {
                const p = centre(a);
                const q = centre(b);
                return <line key={`${a}-${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="var(--color-border)" strokeWidth={10} />;
              })}
              {rows.map((r) => {
                const bin = binOf(valueOf(r), edges);
                const flag = flagOf(r);
                const severe = flag === "Shelter now" || flag === "Ventilate now";
                return (
                  <g
                    key={r.m.id}
                    tabIndex={0}
                    onPointerEnter={() => setHover(r.m.id)}
                    onPointerLeave={() => setHover(null)}
                    onFocus={() => setHover(r.m.id)}
                    onBlur={() => setHover(null)}
                    className="outline-none"
                  >
                    <rect x={r.m.x} y={r.m.y} width={r.m.w} height={r.m.h} rx={14} fill="var(--color-card)" />
                    {bin !== null && <rect x={r.m.x} y={r.m.y} width={r.m.w} height={r.m.h} rx={14} fill="var(--color-series)" opacity={STEP_OPACITY[bin]} />}
                    <rect
                      x={r.m.x}
                      y={r.m.y}
                      width={r.m.w}
                      height={r.m.h}
                      rx={14}
                      fill="none"
                      stroke={flag ? (severe ? "var(--color-emergency)" : "var(--color-warning)") : hover === r.m.id ? "var(--color-ring)" : "var(--color-border)"}
                      strokeWidth={flag ? 3 : hover === r.m.id ? 2 : 1}
                    />
                    <text x={r.m.x + 12} y={r.m.y + 24} fill="var(--color-foreground)" fontSize={15} fontWeight={600}>
                      {r.m.name}
                    </text>
                    <text x={r.m.x + 12} y={r.m.y + 44} fill="var(--color-foreground)" fontSize={13} className="tabular-nums">
                      {fmt(r)}
                    </text>
                    {flag && (
                      <text x={r.m.x + 12} y={r.m.y + 62} fill={severe ? "var(--color-emergency)" : "var(--color-warning)"} fontSize={12} fontWeight={700}>
                        {flag.toUpperCase()}
                      </text>
                    )}
                    {r.here.map((id, i) => (
                      <g key={id} transform={`translate(${r.m.x + 12 + i * 62}, ${r.m.y + r.m.h - 32})`}>
                        <rect width={56} height={22} rx={11} fill="var(--color-background)" stroke={id === me?.crewMemberId ? "var(--color-info)" : "var(--color-border)"} />
                        <text x={28} y={15} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--color-foreground)">
                          {callsign.get(id) ?? "crew"}
                        </text>
                      </g>
                    ))}
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Map key">
            <span className="flex items-center gap-1">
              {STEP_OPACITY.map((o, i) => (
                <span key={i} className="inline-block h-3 w-5 rounded-sm bg-series" style={{ opacity: o }} aria-hidden />
              ))}
              <span className="ml-1">
                {layer === "noise"
                  ? `quieter → louder (steps at ${NOISE_EDGES.join(", ")} dBA)`
                  : layer === "air"
                    ? `fresher → more CO₂ (steps at ${CO2_EDGES.join(", ")} ppm)`
                    : `lower → higher (steps at ${DOSE_EDGES.join(", ")} µSv/h)`}
              </span>
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-3 w-5 rounded-sm border-2 border-warning" aria-hidden /> {layer === "noise" ? "over noise limit" : layer === "air" ? "air needs checking" : "elevated"}
            </span>
            {layer !== "noise" && (
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-5 rounded-sm border-2 border-emergency" aria-hidden /> {layer === "air" ? "ventilate now" : "shelter now"}
              </span>
            )}
            <span>Radiation per module = highest dose rate among the crew dosimeters there.</span>
          </div>
        </CardContent>
      </Card>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Module</th>
              <th className="px-3 py-2 font-medium">Noise</th>
              <th className="px-3 py-2 font-medium">Air (CO₂ · O₂ · RH · T)</th>
              <th className="px-3 py-2 font-medium">Dose rate</th>
              <th className="px-3 py-2 font-medium">Crew here</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.m.id} className={cn("border-t border-border", hover === r.m.id && "bg-muted")}>
                <td className="px-3 py-1.5 font-semibold">{r.m.name}</td>
                <td className="px-3 py-1.5 tabular-nums">
                  {r.noise ? (
                    <>
                      {r.noise.laeq.toFixed(1)} dBA{r.noise.limit ? " · over limit" : ""} · <Ago iso={r.noise.at} />
                    </>
                  ) : r.m.acoustic ? (
                    "no reading"
                  ) : (
                    "no sensor"
                  )}
                </td>
                <td className="px-3 py-1.5 tabular-nums">
                  {r.air ? (
                    <>
                      {Math.round(r.air.co2_ppm).toLocaleString("en-US")} ppm · {r.air.o2_pct.toFixed(1)}% · {Math.round(r.air.humidity_pct)}% · {r.air.temp_c.toFixed(1)} °C
                      {r.airCheck && r.airCheck.issues.length > 0 && (
                        <ul className={cn("text-xs", r.airCheck.tone === "emergency" ? "text-emergency" : "text-caution")}>
                          {r.airCheck.issues.map((i) => (
                            <li key={i}>{i}</li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    "no sensor"
                  )}
                </td>
                <td className="px-3 py-1.5 tabular-nums">{r.rate === null ? "—" : `${Math.round(r.rate).toLocaleString("en-US")} µSv/h`}</td>
                <td className="px-3 py-1.5">{r.here.map((id) => callsign.get(id) ?? "crew").join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
