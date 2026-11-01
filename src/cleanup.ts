// SPDX-License-Identifier: Apache-2.0
// W-15: keeping the store small. `tiresias clear` and the once-a-day automatic
// trim both come through clearStore().
//
// Nothing here rewrites a file. History and receipts live in one file per local
// day (history/YYYY-MM-DD.jsonl, receipts/YYYY-MM-DD.jsonl), so retention and
// the disk cap only ever DELETE whole files: a day file, a cached page, or a
// legacy v0.1 history.jsonl / receipts.jsonl, or (W-06) one handoff ticket past
// keep_handoff_days. cooldowns.jsonl, the legacy cooldown store and bookmarks/ are
// never touched, not even by --all.
// W-18: everything here works on the folder of the profile this process serves. On `default` (the
// root) it never looks inside profiles/, so even `clear --all` cannot touch another profile.
// The plan is built first and applied second, so --dry-run reports exactly what
// a real run would remove. A store that does not exist is simply "nothing there".
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { loadLimits, type Limits } from "./config.js";
import { LEGACY } from "./cooldown.js";
import * as handoffs from "./handoffs.js";
import * as slips from "./slips.js";
import * as saved from "./saved.js";
import { sweepHosts } from "./hosts.js";
import { staleQuarantine, sweepQuarantine } from "./scanner.js";
import { browseItems, foreignFolders, removeBrowseItem, scanIncomplete, type BrowseItem } from "./browseclear.js";
import { NOFOLLOW, NONBLOCK, cachePath, homeDir, isPrivate, listLogs, localDay, ownFile, readCacheDir, readHome, readOwnedText, PROFILES_FOLDER, rmRegular, SHARED, writeJson } from "./store.js";

const DAY = 86_400_000;

export interface Part {
  removed: number; // files
  kept: number; // files
  bytes_freed: number;
}
export interface ClearReport {
  dry_run: boolean;
  history: Part;
  receipts: Part;
  cache: Part;
  handoffs: Part; // W-06: expired handoff tickets (never removed for the disk cap)
  tabs: Part; // v0.6 W-24: the command line's tab session file (browseclear.ts)
  shelf: Part; // v0.6 W-27: the downloads shelf's day files (browseclear.ts)
  scan_incomplete?: string[]; // v0.6: what this run did not finish (a folder's entry budget, or "store size"); run clear again
  not_removed?: number; // v0.6: tabs/ and shelf/ entries that could not be removed (counted as kept)
  foreign_folders?: number; // v0.6: folders in tabs/ or shelf/ that Tiresias did not make; never entered, for the owner to remove
  slips_problem?: string; // W-05: fixed text when the slip key cannot be used; slip cleanup was skipped, the rest ran
  saved: Part; // W-28 (v0.8): snapshots past keep_saved_days or over max_saved_mb, and leftover temp folders; never by --all or --older-than
  slips: Part; // W-05: expired and used-up slips (each with its use files) and leftover files; active slips are never removed, not even by --all
  disk_cap: { limit_bytes: number; over_by_bytes: number; files_removed: number };
  quarantine: number; // W-21: scanner copies left behind by a process that stopped mid-call (over 10 minutes old)
  total_bytes_freed: number;
  store_bytes_after: number;
  summary: string;
}

interface Item {
  kind: "history" | "receipts" | "cache" | "handoffs" | "tabs" | "shelf";
  file: string;
  size: number;
  age: number; // ms: start of the day for a day file, newest line for a legacy file, mtime for a cache file
  end: number; // ms: when the last possible line in it is older than this (day end, newest line, or mtime)
}

const empty = (): Part => ({ removed: 0, kept: 0, bytes_freed: 0 });

// Newest time in a legacy single-file log (read only). Falls back to the file's mtime.
async function newestLine(file: string, mtime: number): Promise<number> {
  let best = 0;
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch {
    return mtime;
  }
  try {
    ownFile(fd, file);
    const rl = readline.createInterface({ input: fs.createReadStream(file, { fd, autoClose: false }), crlfDelay: Infinity });
    for await (const line of rl) {
      try {
        const o = JSON.parse(line) as { time?: unknown; recorded_at?: unknown };
        const t = Date.parse(String(o?.time ?? o?.recorded_at ?? ""));
        if (t > best) best = t;
      } catch {
        // skip damaged and blank lines
      }
    }
  } catch {
    return mtime;
  } finally {
    fs.closeSync(fd);
  }
  return best || mtime;
}

async function gather(h: string): Promise<Item[]> {
  const items: Item[] = [];
  for (const group of ["history", "receipts"] as const)
    for (const f of listLogs(group)) {
      const file = path.join(h, f.rel);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(file);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (f.day) {
        // Day files are named by UTC date, so their age does not depend on this machine's timezone.
        const [y, m, d] = f.day.split("-").map(Number);
        const start = Date.UTC(y, m - 1, d);
        items.push({ kind: group, file, size: st.size, age: start, end: start + DAY });
      } else {
        const t = await newestLine(file, st.mtimeMs);
        items.push({ kind: group, file, size: st.size, age: t, end: t });
      }
    }
  const dir = readCacheDir(); // throws if cache/ is a link or someone else's: then nothing is deleted
  let names: string[] = [];
  try {
    if (dir) names = fs.readdirSync(dir);
  } catch {
    // no cache folder
  }
  const legacyCooldown = path.basename(cachePath(LEGACY));
  for (const n of names) {
    if (n === legacyCooldown || (!n.endsWith(".json") && !n.endsWith(".tmp"))) continue; // the old cooldown store is never removed
    const file = path.join(dir!, n);
    try {
      const st = fs.lstatSync(file);
      if (st.isFile()) items.push({ kind: "cache", file, size: st.size, age: st.mtimeMs, end: st.mtimeMs });
    } catch {
      // vanished while listing
    }
  }
  // W-06: a ticket's age is its own created_at (its mtime if the file is damaged). Throws if
  // handoffs/ is a link or someone else's: then nothing is deleted.
  for (const t of handoffs.files()) items.push({ kind: "handoffs", file: t.file, size: t.size, age: t.created, end: t.created });
  items.push(...browseItems(Date.now())); // v0.6 Track 2
  return items;
}

// Bookmarks (W-16) are the owner's saved list, not browsing data: never removed, and not
// counted against the disk cap (at most 1,000 files of a few hundred bytes). The same goes for the
// Safe Browsing list in safety/ (W-19): about 11 MB, replaced whole once a day, never evicted.
// W-18: each profile has its own cap over its own folder. The `default` profile is the root, so its
// count leaves out profiles/ (the other profiles) and the entries every profile shares (safety/ and
// the cooldown logs), which no profile's cap can remove.
// W-05: slips/ is not counted either: permissions, at most 200 small slips per profile.
// W-28: saved/ has its own cap (max_saved_mb), so the main cap never evicts a snapshot to make room for cache.
// W-08: anchors/ holds only hashes and salts (no browsing data) and is what keeps old proofs provable: not counted.
const NOT_COUNTED = new Set(["bookmarks", "slips", "saved", "anchors", PROFILES_FOLDER, ...SHARED]);
// v0.6 (Codex browse rounds 3, 5 and 6): walked as a stream, so a folder with a huge number of entries never
// has to fit in memory at once, with a budget of MEASURE.max entries and MEASURE_DEPTH levels, so a tampered
// store cannot stall the trim. A count that did not finish is a LOWER bound: the disk cap is still applied
// with it (it can only evict less than a full count would, never more), and the report says so. Folders
// inside tabs/ and shelf/ are not Tiresias's (it never makes any there, and never enters or removes them),
// so they are not counted or entered.
const FLAT = new Set(["tabs", "shelf"]);
export const MEASURE = { max: 1_000_000 }; // an object so the test suite can lower it
const MEASURE_DEPTH = 64; // a deeper tree is not measured whole (each level holds a folder handle open)
function storeBytes(dir: string, budget = { left: MEASURE.max }, top = true, depth = 0): { total: number; complete: boolean } {
  let total = 0;
  let complete = true;
  if (depth > MEASURE_DEPTH) return { total, complete: false };
  let d: fs.Dir;
  try {
    d = fs.opendirSync(dir);
  } catch (e) {
    if (top) throw e;
    return { total, complete: false }; // a folder that cannot be opened is not "empty"
  }
  try {
    for (let e = d.readSync(); e !== null; e = d.readSync()) {
      if (top && NOT_COUNTED.has(e.name)) continue;
      if (budget.left-- <= 0) return { total, complete: false };
      const f = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          if (depth === 1 && FLAT.has(path.basename(dir))) continue; // a foreign folder in tabs/ or shelf/
          const sub = storeBytes(f, budget, false, depth + 1);
          total += sub.total;
          if (!sub.complete) return { total, complete: false };
        } else if (e.isFile()) total += fs.lstatSync(f).size;
      } catch {
        // vanished while measuring
      }
    }
  } finally {
    d.closeSync();
  }
  return { total, complete };
}

export interface ClearOptions {
  limits?: Limits;
  olderThanMs?: number; // overrides every age limit for this run (whole days from the CLI)
  all?: boolean; // every history, receipts, cached page and handoff ticket file; cooldowns and bookmarks are never touched
  dryRun?: boolean;
  now?: number; // for tests
}

export async function clearStore(o: ClearOptions = {}): Promise<ClearReport> {
  const limits = o.limits ?? loadLimits();
  const dryRun = !!o.dryRun;
  // Integration Codex round 2 (v0.8): a private session changes nothing in the store, so only a dry run is allowed.
  if (!dryRun && isPrivate()) throw new Error("Private mode: nothing in the store is changed, so nothing is cleared. Use --dry-run to see what clear would remove.");
  const now = o.now ?? Date.now();
  const report: ClearReport = {
    dry_run: dryRun, history: empty(), receipts: empty(), cache: empty(), handoffs: empty(), tabs: empty(), shelf: empty(), slips: empty(), saved: empty(),
    disk_cap: { limit_bytes: limits.max_disk_mb * 1024 * 1024, over_by_bytes: 0, files_removed: 0 },
    quarantine: 0, total_bytes_freed: 0, store_bytes_after: 0, summary: "",
  };
  const h = readHome();
  scanIncomplete.clear(); // v0.6: this run's own report
  foreignFolders.count = 0;
  const items = h ? await gather(h) : [];
  // W-05: slips are permissions, not browsing data. Expired and used-up ones go; --all and the disk cap
  // never remove an active slip. Planned before anything is deleted (a bad slips/ folder or slip key
  // stops the whole clear).
  // Coordinator (Codex round 49): a bad slip key must not block unrelated housekeeping. On a slip-key
  // problem the slip cleanup alone is skipped (every slip left untouched) and the problem is reported.
  let slipPlan: slips.SlipCleanup = { retire: [], files: [], kept: 0 };
  if (h)
    try {
      slipPlan = slips.planCleanup(now);
    } catch (e) {
      if (!(e instanceof slips.SlipError)) throw e;
      report.slips_problem = `Slips were not cleaned up (all left as they are): ${e.message}`;
    }
  const days: Record<Item["kind"], number> = {
    history: limits.keep_history_days, receipts: limits.keep_receipts_days, cache: limits.keep_cache_days,
    handoffs: limits.keep_handoff_days ?? handoffs.DEFAULT_KEEP_DAYS,
    tabs: limits.keep_history_days, // the tab session holds URLs read, like history
    shelf: limits.keep_receipts_days, // file warnings were kept with the receipts before v0.6
  };
  const doomed = new Set<Item>();
  for (const it of items) {
    const cut = now - (o.olderThanMs ?? days[it.kind] * DAY);
    // A .tmp file younger than a day may be another process's write in progress: never removed, not even
    // by --all (v0.5.1).
    const tmp = it.file.endsWith(".tmp");
    const stale = tmp ? it.age < now - DAY : it.end <= cut;
    if (stale || (o.all && !tmp)) doomed.add(it);
  }
  const part = (it: Item) => report[it.kind];
  const measured = h ? storeBytes(h) : { total: 0, complete: true };
  let total = measured.total;
  for (const it of doomed) total -= it.size;
  // W-21 leftovers are planned BEFORE the disk cap (round 68): the room they free counts, so the cap
  // never evicts cache files the sweep alone would have made room for.
  const qPlan = h ? staleQuarantine(now) : [];
  for (const q of qPlan) total -= q.bytes;

  // Disk cap: oldest first. Cached pages go before logs; history and receipts compete as one pool.
  // Open handoff tickets are counted in the total but never removed for the cap (at most 500 small
  // files, and each is a person's pending task): they go only when they expire.
  report.disk_cap.over_by_bytes = Math.max(0, total - report.disk_cap.limit_bytes);
  if (!measured.complete) scanIncomplete.add("store size"); // v0.6: a lower bound; the cap still applies with it
  if (total > report.disk_cap.limit_bytes) {
    // A .tmp file younger than a day is another process's write in progress: never evicted (Codex round 69).
    const rest = items.filter((i) => !doomed.has(i) && i.kind !== "handoffs" && !(i.file.endsWith(".tmp") && i.age >= now - DAY));
    const order = [...rest.filter((i) => i.kind === "cache").sort((a, b) => a.age - b.age), ...rest.filter((i) => i.kind !== "cache").sort((a, b) => a.age - b.age)];
    for (const it of order) {
      if (total <= report.disk_cap.limit_bytes) break;
      doomed.add(it);
      total -= it.size;
      report.disk_cap.files_removed++;
    }
  }

  for (const it of items) {
    if (doomed.has(it)) {
      // v0.6: browse items are removed without following a link, and counted only when really gone (Codex
      // browse round 6); one that could not be removed is kept and reported.
      if (!dryRun && (it.kind === "tabs" || it.kind === "shelf")) {
        const r = removeBrowseItem(it as BrowseItem);
        if (r !== "removed") {
          part(it).kept++;
          if (r === "failed") report.not_removed = (report.not_removed ?? 0) + 1;
          total += it.size;
          continue;
        }
      }
      if (!dryRun && it.kind !== "tabs" && it.kind !== "shelf") rmRegular(it.file);
      part(it).removed++;
      part(it).bytes_freed += it.size;
    } else part(it).kept++;
  }
  if (!dryRun) slips.applyCleanup(slipPlan, now);
  // W-28: snapshots go by their own age and cap only.
  let savedPlan: saved.SavedCleanup = { remove: [], kept: 0 };
  try {
    if (h) savedPlan = saved.planCleanup(now, limits);
  } catch {
    // a saved/ folder that is not a plain folder of ours: left alone (nothing there is ever followed)
  }
  report.saved = dryRun
    ? { removed: savedPlan.remove.length, kept: savedPlan.kept, bytes_freed: savedPlan.remove.reduce((n, r) => n + r.bytes, 0) }
    : saved.applyCleanup(savedPlan);
  const swept = h ? sweepQuarantine(now, dryRun, qPlan) : { removed: 0, bytes: 0 };
  if (!dryRun) sweepHosts(now); // N-06 spacing files over a day old (shared, not counted by the cap)
  report.quarantine = swept.removed;
  report.slips = {
    removed: slipPlan.retire.length + slipPlan.files.length,
    kept: slipPlan.kept,
    bytes_freed: [...slipPlan.retire, ...slipPlan.files].reduce((n, x) => n + x.bytes, 0),
  };
  if (scanIncomplete.size) report.scan_incomplete = [...scanIncomplete].sort();
  if (foreignFolders.count) report.foreign_folders = foreignFolders.count;
  report.total_bytes_freed = report.history.bytes_freed + report.receipts.bytes_freed + report.cache.bytes_freed + report.handoffs.bytes_freed + report.tabs.bytes_freed + report.shelf.bytes_freed + report.slips.bytes_freed + report.saved.bytes_freed + swept.bytes;
  report.store_bytes_after = Math.max(0, total);
  report.summary =
    `${dryRun ? "Would remove" : "Removed"} ${report.history.removed} history files, ${report.receipts.removed} receipts files, ${report.cache.removed} cached pages, ${report.handoffs.removed} handoff tickets, ${report.tabs.removed ? `${report.tabs.removed} tab session, ` : ""}${report.shelf.removed ? `${report.shelf.removed} shelf day files, ` : ""}${report.slips.removed} expired or used-up slips (and leftovers)${report.saved.removed ? `, ${report.saved.removed} saved snapshots past their age or cap` : ""}${report.quarantine ? `, ${report.quarantine} leftover scanner copies` : ""}; ` +
    `${dryRun ? "would free" : "freed"} ${report.total_bytes_freed} bytes. Store is ${report.store_bytes_after} bytes. Cooldowns are never removed.` +
    (report.slips_problem ? ` ${report.slips_problem}` : "") +
    (report.scan_incomplete ? ` Not finished this run: ${report.scan_incomplete.join(", ")} (each run looks at a bounded number of entries${report.scan_incomplete.includes("store size") ? "; the store was not measured whole, so the disk cap used a lower count and may have removed less than it should" : ""}); run clear again to go on.` : "") +
    (report.not_removed ? ` ${report.not_removed} files in tabs/ or shelf/ could not be removed (check their permissions).` : "") +
    (report.foreign_folders ? ` ${report.foreign_folders} folders in tabs/ or shelf/ were not made by Tiresias; it never enters or removes them, so remove them yourself.` : "") +
    (report.scan_incomplete?.some((x) => x === "tabs" || x === "shelf")
      ? " A run looks at a bounded number of entries of tabs/ and shelf/, and always from the start: if what it keeps there (data it is keeping, live locks, folders it did not make) fills that number, later runs cannot reach the rest, so remove what you do not need there yourself."
      : "");
  return report;
}

// Automatic enforcement: at most once per local day per store, on a normal call.
// Keyed by store path AND local date, so a long-running MCP server trims again each day.
// Never throws: a read must not fail because of housekeeping. Never touches cooldowns.
const checked = new Set<string>();
export async function enforceLimits(now = Date.now()): Promise<void> {
  try {
    const h = readHome();
    const today = localDay(now);
    const key = `${h ?? ""}|${today}`;
    if (checked.has(key)) return;
    checked.add(key);
    let last = 0;
    try {
      last = Number((JSON.parse(readOwnedText("maintenance.json") ?? "{}") as { last?: number }).last) || 0;
    } catch {
      // unreadable marker: treat as never run
    }
    if (last && localDay(last) === today) return;
    const limits = loadLimits();
    if (h) {
      const r = await clearStore({ limits, now });
      if (r.slips_problem) console.error(`Tiresias storage cleanup: ${r.slips_problem}`);
    }
    writeJson(path.join(homeDir(), "maintenance.json"), { last: now });
  } catch (e) {
    console.error(`Tiresias storage cleanup skipped: ${(e as Error).message}`);
  }
}
