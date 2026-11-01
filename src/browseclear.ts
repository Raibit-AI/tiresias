// SPDX-License-Identifier: Apache-2.0
// v0.6 Track 2: what `clear` and the daily trim see of the browse stores. Whole files only, like every
// other part of clear: the command line's tab session (tabs/cli.json and any leftover temp file of it) and
// the downloads shelf's day files (shelf/YYYY-MM-DD.jsonl, aged by their UTC day like the history files).
import fs from "node:fs";
import path from "node:path";
import { subDir, utcDay } from "./store.js";
import { acquire, breakDead, leftover, release } from "./browselock.js";
import { CLI_FILE, TABS_DIR } from "./tabs.js";
import { MARK_FILE, SHELF_DIR } from "./shelf.js";

const DAY = 86_400_000;
const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

export interface BrowseItem {
  kind: "tabs" | "shelf";
  file: string;
  size: number;
  age: number;
  end: number; // 0 = remove on any clear (an entry Tiresias did not make, or a dead owner's lock)
  data?: { ino: number; mtimeMs: number; size: number }; // round 7: a data file's identity when planned
}

// Codex browse rounds 3 to 6: each folder is walked as a stream (never loaded whole), top level only, with
// a budget of SCAN_MAX entries per run. Every file or link Tiresias does not make there is removed (a link
// is unlinked itself, never followed: it is a direct child of a folder the store checked). A FOLDER that
// Tiresias did not make is never entered or removed: deleting inside it safely would mean trusting every
// path component under it, so it is only counted (`foreign_folders`) for the owner to remove. Nothing about
// such a folder can block a run: it is one entry. A run that ran out of budget says so (`scan_incomplete`).
export const SCAN_MAX = 20_000;
export const scanIncomplete = new Set<string>(); // folders the last gather did not finish, for the report
export const foreignFolders = { count: 0 }; // folders found in tabs/ and shelf/ by the last gather

const junk = (kind: BrowseItem["kind"], file: string, size: number): BrowseItem => ({ kind, file, size, age: 0, end: 0 });
const ident = (st: fs.Stats) => ({ ino: st.ino, mtimeMs: st.mtimeMs, size: st.size });

function walk(d: string, name: string, each: (n: string, file: string, st: fs.Stats) => void): void {
  let dir: fs.Dir;
  try {
    dir = fs.opendirSync(d);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // gone meanwhile: nothing there
    // Round 8: a folder that cannot be read (no permission, an I/O error) stops clear while it is still
    // planning, before anything is deleted, rather than being treated as empty.
    throw new Error(`${d} cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"}), so clear stopped before removing anything. Check its permissions.`);
  }
  try {
    let seen = 0;
    for (let e = dir.readSync(); e !== null; e = dir.readSync()) {
      if (seen++ >= SCAN_MAX) {
        scanIncomplete.add(name);
        break;
      }
      const file = path.join(d, e.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // vanished while listing
        // Round 9: an entry that cannot be looked at (no search permission, an I/O error) stops clear while
        // it is planning, before anything is removed, rather than being skipped as if it were gone.
        throw new Error(`${d} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"}), so clear stopped before removing anything. Check its permissions.`);
      }
      each(e.name, file, st);
    }
  } finally {
    dir.closeSync();
  }
}

// Throws when tabs/ or shelf/ is a link or someone else's folder: then clear deletes nothing, as for the others.
export function browseItems(now = Date.now()): BrowseItem[] {
  scanIncomplete.clear();
  foreignFolders.count = 0;
  return [...shelfItems(now), ...tabItems(now)];
}

// The only lock names Tiresias makes: the session file's lock in tabs/, and today's or yesterday's (UTC) day
// file lock in shelf/ (a record is written in milliseconds, so no older day's lock can be in use), each with
// its `.break` files. Anything else shaped like a lock is junk (Codex browse round 5).
const LOCK_TAIL = /\.lock(\.break){0,2}$/;
function ourLock(kind: BrowseItem["kind"], n: string, now: number): boolean {
  if (!LOCK_TAIL.test(n)) return false;
  const base = n.replace(LOCK_TAIL, "");
  if (kind === "tabs") return base === CLI_FILE;
  // Round 9: every well-formed day file lock is protected by its owner, whatever its date (a paused writer or
  // a clock change can leave a live lock on an older day). `now` is unused since then.
  void now;
  return DAY_FILE.test(base);
}

function plan(kind: BrowseItem["kind"], n: string, file: string, st: fs.Stats, now: number, out: BrowseItem[]): void {
  if (st.isFile() && ourLock(kind, n, now)) {
    if (leftover(file, now)) out.push(junk(kind, file, st.size)); // removed through breakDead, never a live owner's
    return;
  }
  if (st.isDirectory()) {
    foreignFolders.count++; // never entered or removed (see above)
    return;
  }
  // A file or link Tiresias does not make here. A temp file keeps its own time, so clear's rule for temp
  // files (never one under a day old: it may be a write in progress, such as a lock being published) holds.
  if (st.isFile() && n.endsWith(".tmp")) return void out.push({ kind, file, size: st.size, age: st.mtimeMs, end: 0 });
  out.push(junk(kind, file, st.isFile() ? st.size : 0));
}

// Round 10: a day file and its `.incomplete` marker are ONE item (the day's, with the marker's bytes added),
// so the disk cap can never pick a marker that cannot go while its day stays. A marker whose day file is gone
// is its own item, aged by its date like the day it stands for.
function shelfItems(now: number): BrowseItem[] {
  const out: BrowseItem[] = [];
  const d = subDir(SHELF_DIR, false);
  if (!d) return out;
  const days = new Map<string, BrowseItem>();
  const marks = new Map<string, { file: string; st: fs.Stats }>();
  const start = (day: string) => {
    const [y, m, dd] = day.split("-").map(Number);
    return Date.UTC(y, m - 1, dd);
  };
  walk(d, SHELF_DIR, (n, file, st) => {
    const dm = st.isFile() ? DAY_FILE.exec(n) : null;
    const mm = st.isFile() ? MARK_FILE.exec(n) : null;
    const day = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : mm?.[1];
    if (day && !Number.isNaN(start(day))) {
      if (dm) days.set(day, { kind: "shelf", file, size: st.size, age: start(day), end: start(day) + DAY, data: ident(st) });
      else marks.set(day, { file, st });
      return;
    }
    plan("shelf", n, file, st, now, out);
  });
  for (const [day, it] of days) {
    const mk = marks.get(day);
    if (mk) it.size += mk.st.size; // freed together with the day
    out.push(it);
  }
  for (const [day, mk] of marks)
    if (!days.has(day)) out.push({ kind: "shelf", file: mk.file, size: mk.st.size, age: start(day), end: start(day) + DAY, data: ident(mk.st) });
  return out;
}

function tabItems(now: number): BrowseItem[] {
  const out: BrowseItem[] = [];
  const d = subDir(TABS_DIR, false);
  if (!d) return out;
  walk(d, TABS_DIR, (n, file, st) => {
    if (st.isFile() && n === CLI_FILE) out.push({ kind: "tabs", file, size: st.size, age: st.mtimeMs, end: st.mtimeMs, data: ident(st) });
    else if (st.isFile() && n.startsWith(CLI_FILE + ".") && n.endsWith(".tmp")) out.push({ kind: "tabs", file, size: st.size, age: st.mtimeMs, end: st.mtimeMs });
    else plan("tabs", n, file, st, now, out);
  });
  return out;
}

// Remove one planned item, a direct child of tabs/ or shelf/ of this profile, without following a link.
//  - our lock files: through the lock's own breaking rule (a lock taken over since the plan is left alone);
//  - our data files (the tab session, a shelf day file or its marker): under the same lock their writers
//    take, and only if the file is still the one that was planned (same inode, time and size), so a session
//    saved or a record added after the plan is never lost (Codex browse round 7);
//  - anything else: unlinked (a link is removed itself).
// "removed" only when it is really gone; "kept" when it changed since the plan (not an error); "failed"
// when it could not be removed (counted as kept and reported).
export type Removal = "removed" | "kept" | "failed";
export function removeBrowseItem(it: { file: string; data?: { ino: number; mtimeMs: number; size: number } }, now = Date.now()): Removal {
  const file = it.file;
  // Round 9: only "it does not exist" counts as gone; any other trouble looking at it is a failure.
  const look = (f: string): fs.Stats | "gone" | "error" => {
    try {
      return fs.lstatSync(f);
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "error";
    }
  };
  const gone = (f = file): Removal => (look(f) === "gone" ? "removed" : "failed");
  const st = look(file);
  if (st === "gone") return "removed";
  if (st === "error") return "failed";
  const roots: [BrowseItem["kind"], string | null][] = [["shelf", subDir(SHELF_DIR, false)], ["tabs", subDir(TABS_DIR, false)]];
  const hit = roots.find(([, r]) => r !== null && path.dirname(file) === r);
  if (!hit || st.isDirectory()) return "failed";
  const n = path.basename(file);
  try {
    if (st.isFile() && ourLock(hit[0], n, now)) return breakDead(file, now) ? "removed" : gone() === "removed" ? "removed" : "kept";
    if (it.data) {
      // The writer's lock: the session file's own, or the day file's for a day file and its marker.
      const marker = MARK_FILE.test(n);
      const dayFile = hit[0] === "shelf" ? path.join(hit[1]!, n.replace(/\.incomplete$/, ".jsonl")) : file;
      const o = acquire(dayFile, Date.now, 0); // never waits: a busy writer means "not this run" (round 8)
      if (!o) return "failed";
      try {
        const cur = look(file);
        if (cur === "gone") return "removed";
        if (cur === "error") return "failed";
        if (!cur.isFile() || cur.ino !== it.data.ino || cur.mtimeMs !== it.data.mtimeMs || cur.size !== it.data.size) return "kept";
        // Round 9: a day and its incomplete marker go together. The marker alone goes only once its day is
        // gone; removing a day also removes its marker, under the same lock.
        if (marker) {
          const day = look(dayFile);
          if (day === "error") return "failed";
          if (day !== "gone") return "kept";
        }
        fs.unlinkSync(file);
        if (!marker && hit[0] === "shelf") {
          const m = path.join(hit[1]!, n.replace(/\.jsonl$/, ".incomplete"));
          if (look(m) !== "gone") fs.unlinkSync(m);
        }
      } finally {
        release(o);
      }
      return gone();
    }
    fs.unlinkSync(file);
  } catch {
    return gone();
  }
  return gone();
}
