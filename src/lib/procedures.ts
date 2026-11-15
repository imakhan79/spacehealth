// Guided medical protocols for the crew. Content is a training-grade outline
// for the demo, not medical advice: a real mission uses its flight surgeons'
// approved procedures. Steps may carry a timer (seconds) shown as a countdown.

export interface ProtocolStep {
  text: string;
  timerSec?: number;
  /** Must be done before the run can be completed. */
  critical?: boolean;
}

export interface Protocol {
  id: string;
  title: string;
  summary: string;
  steps: ProtocolStep[];
}

export const PROTOCOLS: Protocol[] = [
  {
    id: "chest_pain",
    title: "Chest pain",
    summary: "Possible cardiac event: assess, monitor, treat, and contact the flight surgeon.",
    steps: [
      { text: "Stop all activity; patient rests, restrained in a comfortable position.", critical: true },
      { text: "Attach ECG leads and pulse oximeter; record HR, SpO₂, blood pressure.", critical: true },
      { text: "Give aspirin 325 mg to chew, unless allergic.", critical: true },
      { text: "Start oxygen if SpO₂ is below 94%." },
      { text: "Recheck vitals.", timerSec: 300 },
      { text: "Notify the flight surgeon at the next comm opportunity; flag urgent.", critical: true },
    ],
  },
  {
    id: "burn",
    title: "Burn",
    summary: "Thermal or electrical burn: stop the burning, cool, cover, assess.",
    steps: [
      { text: "Remove the source; for electrical burns, isolate power first.", critical: true },
      { text: "Cool the burn with clean water.", timerSec: 600, critical: true },
      { text: "Remove rings and tight items near the burn before swelling." },
      { text: "Cover loosely with sterile non-adherent dressing." },
      { text: "Estimate size (patient's palm ≈ 1% of body surface) and record.", critical: true },
      { text: "Give pain relief from the med kit as directed." },
    ],
  },
  {
    id: "eye_injury",
    title: "Eye injury / foreign body",
    summary: "Floating debris is common in microgravity: irrigate, assess, protect.",
    steps: [
      { text: "Do not let the patient rub the eye.", critical: true },
      { text: "Irrigate with eye wash, from the inner corner outward.", timerSec: 300, critical: true },
      { text: "Check vision in each eye (read a label at arm's length) and record." , critical: true },
      { text: "If pain or vision loss persists, apply an eye shield." },
      { text: "Notify the flight surgeon." },
    ],
  },
  {
    id: "anaphylaxis",
    title: "Allergic reaction (anaphylaxis)",
    summary: "Breathing difficulty, swelling or hives after exposure: epinephrine first.",
    steps: [
      { text: "Give epinephrine auto-injector into the outer thigh.", critical: true },
      { text: "Record time of injection; check breathing and pulse.", critical: true },
      { text: "Start oxygen; position for easier breathing." },
      { text: "If no improvement, second epinephrine dose.", timerSec: 300 },
      { text: "Give antihistamine from the med kit." },
      { text: "Notify the flight surgeon; flag urgent.", critical: true },
    ],
  },
];

export function protocolById(id: string): Protocol | undefined {
  return PROTOCOLS.find((p) => p.id === id);
}

/** Critical steps not yet done; a run can't be marked completed until this is empty. */
export function missingCritical(protocol: Protocol, doneSteps: number[]): number[] {
  const done = new Set(doneSteps);
  return protocol.steps.map((s, i) => (s.critical && !done.has(i + 1) ? i + 1 : 0)).filter((n) => n > 0);
}
