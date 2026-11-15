// "How to use this page" guides, one per crew page. Shown collapsible at the
// top of each page and all together on /help, so they never disagree.

export type HelpPage =
  | "dashboard"
  | "eva"
  | "monitor"
  | "care"
  | "sleep"
  | "nutrition"
  | "habitat"
  | "supplies"
  | "procedures"
  | "timeline"
  | "handover";

export interface Guide {
  title: string;
  href: string;
  summary: string;
  steps: string[];
}

export const GUIDES: Record<HelpPage, Guide> = {
  dashboard: {
    title: "Dashboard",
    href: "/dashboard",
    summary: "The whole crew's health at a glance. Start every shift here.",
    steps: [
      "Read the four tiles at the top first: open alerts, crew within limits, peak dose rate and the loudest module. A coloured edge and a status line mean something needs a look.",
      "Each crew card shows the latest vitals. The badge says Nominal, Caution or Emergency; a tinted tile is the vital that is out of range.",
      "An amber \"reaches caution in about N min\" line is an early warning: that vital is still normal but trending toward its limit.",
      "Warnings and emergencies raise the red/orange banner and a sound. Press Acknowledge once you've seen the alert; Silence 5 min only quiets the sound for alerts already showing.",
      "If the browser blocks sound, press Enable alarm sound once.",
      "Messages from Mission Control appear on the right. Open one to read it fully, then press Mark read.",
      "The bar at the very top shows the link: Local mode means no Earth link, which is normal; everything is still saved aboard.",
    ],
  },
  eva: {
    title: "EVA monitor",
    href: "/eva",
    summary: "Spacewalk suit telemetry for the crew member running the EVA from inside.",
    steps: [
      "Before egress you'll see the prebreathe countdown: the spacewalkers breathe pure oxygen to clear nitrogen and prevent the bends.",
      "During the EVA, the big number on each suit card is the time left, set by whichever supply runs out first (oxygen, battery, cooling water or CO₂ scrubber), keeping a 10% reserve.",
      "The four bars show each supply and its own time left. The thin line on each bar marks the reserve.",
      "Watch the cue boxes: \"Return to airlock within N min\" (amber) or \"possible leak, terminate EVA\" (red). A steady pressure fall is flagged before the hard limit.",
      "Commander only: press Terminate EVA, type a reason, then Confirm terminate. It is recorded with who ended it and when, and can't be undone.",
    ],
  },
  monitor: {
    title: "ECG monitor",
    href: "/monitor",
    summary: "Live heart traces for each crew member.",
    steps: [
      "Each strip scrolls like a bedside monitor at the standard 25 mm/s on ECG paper.",
      "Under the trace: the rhythm (normal, fast, slow, irregular) and premature beats per minute. Amber text means the rhythm needs a look.",
      "In this demo the traces are simulated from heart-rate telemetry, and the page says so.",
      "If the station server stops responding, traces stop and the page says there is no live ECG. It never replays old data as if it were live.",
    ],
  },
  care: {
    title: "Care",
    href: "/care",
    summary: "Daily health routine: readiness, check-in, medications, medical kit and exercise.",
    steps: [
      "Readiness today: a score out of 100 with every deduction listed. Ready, Monitor or Medical review is a prompt for a conversation, not a diagnosis.",
      "Check in once a day: hours slept, fatigue and mood (tap 1–5), any symptoms, an optional note, then Check in. You can update it the same day.",
      "Today's doses: press Take when a dose is due. Missed doses show amber and can still be logged late for 12 hours.",
      "Medical kit: press Use 1 when you take an item. Badges show low stock, out of stock, expiring and expired items.",
      "Exercise: the rings show the last 7 days against your weekly prescription. Pick the exercise and minutes, then Log session.",
      "The flight surgeon and commander also see the crew overview and everyone's medications.",
    ],
  },
  sleep: {
    title: "Sleep",
    href: "/sleep",
    summary: "Sleep over the last week and fatigue risk for the next shift.",
    steps: [
      "Each card shows sleep in the last 24 h, the 7-day average and sleep debt against 8 h a night.",
      "The chart has one row per day on a 24-hour clock (UTC). Blue bars are sleep; the shaded area is the lights-off window (22:00–06:00).",
      "The fatigue badge (low, moderate, high) is for the next 08:00 shift, with the reasons listed underneath.",
      "Wearables record sleep automatically. To add one yourself, fill in fell asleep and woke up (UTC) at the bottom, then Log sleep.",
    ],
  },
  nutrition: {
    title: "Nutrition",
    href: "/nutrition",
    summary: "Food and water against daily targets.",
    steps: [
      "Tap a water button or a meal in Quick add each time you eat or drink. Nutrients are filled in for you.",
      "Today, you: each bar is a daily target (energy, protein, calcium, vitamin D, water). Green means met.",
      "Amber \"behind pace\" means you are well short of where you should be for this time of day (checked after 11:00 UTC).",
      "Calcium, vitamin D and protein matter extra in microgravity; thirst is blunted in space, so keep drinking.",
    ],
  },
  habitat: {
    title: "Habitat",
    href: "/habitat",
    summary: "The spacecraft's modules at a glance: noise, air and radiation, and who is where.",
    steps: [
      "Switch the map between Noise, Air (CO₂) and Radiation with the buttons at the top. Darker blue means a higher value.",
      "An orange outline with a label (\"Over limit\", \"Check air\") or a red one (\"Ventilate now\", \"Shelter now\") needs action.",
      "Callsign chips show who is in each module. Set your own location with \"You are in\".",
      "The table under the map has every value in words, including O₂, humidity and temperature.",
    ],
  },
  supplies: {
    title: "Supplies",
    href: "/supplies",
    summary: "How long oxygen, water, food and CO₂ scrubber cartridges will last.",
    steps: [
      "Each card shows stock, use per day (from the last 7 days) and days left at that rate.",
      "The badge compares days left with the next resupply: On track, Tight margin (less than two weeks spare) or Short of resupply (ration now).",
      "The chart shows the last 30 days and the projection to empty; the green line is the resupply date.",
      "Commander only: record a manual count at the bottom after counting stock.",
    ],
  },
  procedures: {
    title: "Procedures",
    href: "/procedures",
    summary: "Guided medical emergency protocols, with every step recorded.",
    steps: [
      "Pick the protocol, choose the patient, press Start. The run appears at the top in red.",
      "Work down the steps and press Done for each. Your callsign and the time are recorded.",
      "Steps with a timer have a button to start a countdown.",
      "Complete unlocks only when every critical step is done. Abort is always available. Add notes before ending.",
      "These are training outlines for the demo; a real mission uses its flight surgeons' approved procedures.",
    ],
  },
  timeline: {
    title: "Timeline",
    href: "/timeline",
    summary: "Everything recorded aboard in the last 48 hours.",
    steps: [
      "Newest events are at the top, grouped by day. Times are UTC.",
      "Filter by crew member, switch event types on or off, or type in the search box.",
      "Each event says who it is about and, where different, who did it.",
    ],
  },
  handover: {
    title: "Handover",
    href: "/handover",
    summary: "A printable summary for the incoming shift.",
    steps: [
      "Choose the shift length (8, 12 or 24 h) at the top.",
      "Per crew member: vitals ranges, time spent in caution or emergency, the longest data gap and dose added.",
      "All alerts with how they were handled, and messages with who read them.",
      "Press Print / save PDF to hand it over on paper or as a file.",
    ],
  },
};

export const GUIDE_ORDER: HelpPage[] = ["dashboard", "eva", "monitor", "care", "sleep", "nutrition", "habitat", "supplies", "procedures", "timeline", "handover"];
