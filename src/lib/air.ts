// Cabin air limits. CO2 follows the crew-health practice of keeping it below
// ~2.0 mmHg (~2,600 ppm) for comfort and headache avoidance, with 4 mmHg
// (~5,300 ppm) treated as an emergency. O2/humidity/temperature are typical
// habitability ranges. These are demo-grade values for a mission's own limits.
import type { Tone } from "../../packages/vital-thresholds/index.ts";

export const AIR = {
  co2: { caution: 2600, emergency: 5300, unit: "ppm" },
  o2: { cautionLow: 19.5, cautionHigh: 23.5, emergencyLow: 17, emergencyHigh: 25, unit: "%" },
  humidity: { low: 25, high: 75, unit: "%" },
  temp: { low: 18, high: 27, unit: "°C" },
} as const;

export interface AirReading {
  co2_ppm: number;
  o2_pct: number;
  humidity_pct: number;
  temp_c: number;
}

export interface AirAssessment {
  tone: Tone;
  issues: string[];
}

export function assessAir(r: AirReading): AirAssessment {
  const issues: string[] = [];
  let tone: Tone = "normal";
  const raise = (t: Tone) => {
    if (t === "emergency" || (t === "caution" && tone === "normal")) tone = t;
  };
  if (r.co2_ppm > AIR.co2.emergency) {
    raise("emergency");
    issues.push(`CO₂ ${Math.round(r.co2_ppm)} ppm: dangerous, ventilate and check scrubber`);
  } else if (r.co2_ppm > AIR.co2.caution) {
    raise("caution");
    issues.push(`CO₂ ${Math.round(r.co2_ppm)} ppm: high, headaches likely`);
  }
  if (r.o2_pct < AIR.o2.emergencyLow || r.o2_pct > AIR.o2.emergencyHigh) {
    raise("emergency");
    issues.push(`O₂ ${r.o2_pct.toFixed(1)}%: outside safe range`);
  } else if (r.o2_pct < AIR.o2.cautionLow || r.o2_pct > AIR.o2.cautionHigh) {
    raise("caution");
    issues.push(`O₂ ${r.o2_pct.toFixed(1)}%: outside normal range`);
  }
  if (r.humidity_pct < AIR.humidity.low || r.humidity_pct > AIR.humidity.high) {
    raise("caution");
    issues.push(`Humidity ${Math.round(r.humidity_pct)}%: outside ${AIR.humidity.low}–${AIR.humidity.high}%`);
  }
  if (r.temp_c < AIR.temp.low || r.temp_c > AIR.temp.high) {
    raise("caution");
    issues.push(`Temperature ${r.temp_c.toFixed(1)} °C: outside ${AIR.temp.low}–${AIR.temp.high} °C`);
  }
  return { tone, issues };
}

/** CO2 classes for the habitat map (ppm): fresh .. high. */
export const CO2_EDGES: [number, number, number, number] = [800, 1500, 2600, 5300];
