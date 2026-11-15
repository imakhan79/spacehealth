// Shown the instant a crew page is requested, while the station data loads,
// so a click is never met with a page that looks frozen.
export default function Loading() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="flex items-center gap-3">
        <span className="size-5 animate-spin rounded-full border-2 border-info border-t-transparent motion-reduce:animate-none" aria-hidden />
        <span className="text-sm text-muted-foreground">Loading station data…</span>
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-hidden>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl border border-border/60 bg-card/60 motion-reduce:animate-none" />
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-hidden>
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="h-64 animate-pulse rounded-xl border border-border/60 bg-card/60 motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}
