// Last good data per page, kept on the device so a page reloaded during a
// station-server outage still shows something (with when it was cached),
// instead of "Loading…" forever. Per signed-in user; cleared at sign-out with
// the rest of the device cache (clearAll in store.ts).

const PREFIX = "omni:page:";
const ME_KEY = "omni:me"; // written by the dashboard: { userId, ... }

function userId(): string | null {
  try {
    const raw = window.localStorage.getItem(ME_KEY);
    const me: unknown = raw ? JSON.parse(raw) : null;
    return typeof me === "object" && me !== null && "userId" in me && typeof me.userId === "string" ? me.userId : null;
  } catch {
    return null;
  }
}

export interface Cached<T> {
  data: T;
  at: number;
}

export function savePageCache<T>(page: string, data: T): void {
  const user = userId();
  if (!user) return;
  try {
    window.localStorage.setItem(`${PREFIX}${user}:${page}`, JSON.stringify({ data, at: Date.now() }));
  } catch {
    // Storage full or blocked: the page still works live, just without a fallback.
  }
}

export function readPageCache<T>(page: string): Cached<T> | null {
  const user = userId();
  if (!user) return null;
  try {
    const raw = window.localStorage.getItem(`${PREFIX}${user}:${page}`);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return typeof parsed === "object" && parsed !== null && "data" in parsed && "at" in parsed ? (parsed as Cached<T>) : null;
  } catch {
    return null;
  }
}

export function clearPageCaches(): void {
  try {
    for (const key of Object.keys(window.localStorage)) if (key.startsWith(PREFIX)) window.localStorage.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

/** The notice a page shows when the station server can't be reached. */
export function outageNotice(cachedAt: number | null): string {
  return cachedAt === null
    ? "Station server not responding, and nothing from this page is cached on this device yet. Retrying…"
    : `Station server not responding. Showing data cached on this device at ${new Date(cachedAt).toISOString().slice(11, 16)}Z; retrying.`;
}
