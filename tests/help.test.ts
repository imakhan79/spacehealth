// Page guides: complete, unique, and one for every navigation tab.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { GUIDES, GUIDE_ORDER } from "../src/lib/help.ts";

test("every guide is listed once, has steps, and links to its page", () => {
  assert.deepEqual([...GUIDE_ORDER].sort(), Object.keys(GUIDES).sort());
  const hrefs = GUIDE_ORDER.map((k) => GUIDES[k].href);
  assert.equal(new Set(hrefs).size, hrefs.length);
  for (const k of GUIDE_ORDER) assert.ok(GUIDES[k].steps.length >= 3, k);
});

test("every navigation tab (except Help) has a guide", () => {
  const nav = readFileSync(resolve(import.meta.dirname, "..", "src/app/(crew)/nav-links.tsx"), "utf8");
  const tabs = [...nav.matchAll(/href: "(\/[a-z]+)"/g)].map((m) => m[1]).filter((h) => h !== "/help");
  const guided = new Set(GUIDE_ORDER.map((k) => GUIDES[k].href));
  for (const t of tabs) assert.ok(guided.has(t!), `no guide for ${t}`);
});
