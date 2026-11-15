import { CircleHelp } from "lucide-react";
import Link from "next/link";
import { GUIDES, GUIDE_ORDER } from "@/lib/help";

export default function HelpPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <CircleHelp className="size-6 text-info" aria-hidden /> How to use OMNI
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One guide per page. Every page also has its own &ldquo;How to use this page&rdquo; box at the top. All times aboard are UTC.
        </p>
      </div>

      <nav aria-label="Guides" className="flex flex-wrap gap-2">
        {GUIDE_ORDER.map((k) => (
          <a key={k} href={`#${k}`} className="rounded-full border border-border px-3 py-1 text-sm text-muted-foreground hover:border-info hover:text-foreground">
            {GUIDES[k].title}
          </a>
        ))}
      </nav>

      <section className="rounded-xl border border-border bg-card/60 p-4 text-sm">
        <h2 className="font-semibold">The basics</h2>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
          <li>Colours always come with words: green / Nominal is fine, amber / Caution needs a look, red / Emergency needs action now.</li>
          <li>Local mode (top bar) means no Earth link. That's normal: everything is saved aboard and sent when the link returns.</li>
          <li>If the station server stops responding, pages keep showing the last data on this device and say when it was cached.</li>
          <li>Use the tabs under the top bar to move between pages.</li>
        </ul>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {GUIDE_ORDER.map((k) => {
          const g = GUIDES[k];
          return (
            <section key={k} id={k} aria-labelledby={`${k}-h`} className="scroll-mt-28 rounded-xl border border-border bg-card/60 p-4">
              <div className="flex items-baseline justify-between gap-2">
                <h2 id={`${k}-h`} className="text-lg font-semibold">
                  {g.title}
                </h2>
                <Link href={g.href} className="text-sm text-info hover:underline">
                  Open →
                </Link>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">{g.summary}</p>
              <ol className="mt-3 flex list-decimal flex-col gap-1.5 pl-5 text-sm marker:text-info">
                {g.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </section>
          );
        })}
      </div>
    </div>
  );
}
