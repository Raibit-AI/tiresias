// SPDX-License-Identifier: Apache-2.0
// W-16: bookmarks. The owner's saved list of sources, by name; some are watched
// (`tiresias watch` checks them for changes, see engine.ts).
//
// One small JSON file per bookmark, bookmarks/<name>.json, so there is no shared
// file to rewrite: adding is an exclusive create, removing deletes that one file,
// and turning watching on or off writes a temp file and renames it over that one
// bookmark. Two processes changing the SAME bookmark at the same moment: the last
// rename wins, and the file is always whole. That is accepted.
//
// Bookmarks are not browsing data: `clear` (even --all) never touches them and the
// disk cap does not count them. A private session never creates the store, so it
// cannot add or change bookmarks (the engine refuses); reading the list is fine.
import fs from "node:fs";
import path from "node:path";
import { parseSafeUrl } from "./safety.js";
import { readItem, removeItem, writeItem } from "./itemfiles.js";
import { subDir } from "./store.js";
import { MAX_URL } from "./types.js";
import { TiresiasError } from "./errors.js";

export interface Bookmark {
  name: string;
  url: string;
  watch: boolean;
  added_at: string;
  // v0.5.1 (W-16): the fingerprint of the page when `watch` last read it, kept here so a watch baseline
  // outlives the page cache's 30-day retention.
  last_fingerprint?: string;
}

export const MAX_BOOKMARKS = 1000;
const NAME = /^[a-z0-9-]{1,64}$/;
const FILE = /^([a-z0-9-]{1,64})\.json$/;
const MAX_FILE = 16 * 1024; // a bookmark is a few hundred bytes; anything bigger is not one

export class BookmarkError extends TiresiasError {
  readonly kind = "bookmark";
}

const BAD_NAME = 'A bookmark name is 1 to 64 characters of a-z, 0-9 and "-" only. That name was refused.';

export function checkName(name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name)) throw new BookmarkError(BAD_NAME);
  return name;
}

// The bookmarks folder, validated like every store sub-folder (a real folder, ours, not a link).
// With create = false nothing is created: a missing store or folder is null.
const folder = (create: boolean): string | null => subDir("bookmarks", create);

const names = (d: string) => fs.readdirSync(d).filter((n) => FILE.test(n)).sort();

// One bookmark file: opened without following links and without blocking, checked to be a
// regular file of ours, size-capped, and checked to hold a bookmark of the same name.
function readOne(d: string, name: string): Bookmark | null {
  const b = readItem(d, name + ".json", MAX_FILE, (why) =>
    new BookmarkError(why === "unreadable" ? "That bookmark file cannot be read (it may be a link or not a plain file)." : why === "too_large" ? "That bookmark file is damaged (too large)." : "That bookmark file is damaged."),
  ) as Bookmark | null;
  if (b === null) return null;
  if (!valid(b, name)) throw new BookmarkError("That bookmark file is damaged.");
  let fp: unknown;
  try {
    const side = readItem(d, name + FP, 1024, () => new BookmarkError("damaged")) as { fp?: unknown; added_at?: unknown } | null;
    fp = side && side.added_at === b.added_at ? side.fp : undefined; // only this bookmark's own baseline
  } catch {
    fp = undefined; // a damaged fingerprint file only means no baseline
  }
  return { name: b.name, url: b.url, watch: b.watch, added_at: b.added_at, ...(typeof fp === "string" && fp.length <= 100 ? { last_fingerprint: fp } : {}) };
}

const valid = (b: Bookmark, name: string) =>
  !!b && typeof b === "object" && b.name === name && typeof b.url === "string" && b.url.length <= MAX_URL &&
  typeof b.watch === "boolean" && typeof b.added_at === "string" && b.added_at.length <= 40;

export function add(name: string, rawUrl: string, watch = false): Bookmark {
  checkName(name);
  const url = parseSafeUrl(rawUrl).href.split("#")[0];
  // URLs are never cut (SPEC 6.1), so one too long to show whole is refused, not shortened.
  if (url.length > MAX_URL) throw new BookmarkError(`That URL is over ${MAX_URL} characters. Bookmarks keep URLs whole, so it was not saved.`);
  const d = folder(true)!;
  // Checked before the create. Two adds at the same moment can pass it by one each; the cap
  // exists to keep the list readable, not as a hard limit.
  if (names(d).length >= MAX_BOOKMARKS) throw new BookmarkError(`There are already ${MAX_BOOKMARKS} bookmarks, the most Tiresias keeps. Remove some first.`);
  const b: Bookmark = { name, url, watch, added_at: new Date().toISOString() };
  try {
    writeItem(d, name + ".json", JSON.stringify({ v: 1, ...b }), "create");
    removeItem(d, name + FP); // made: an earlier bookmark's baseline is not this one's (only now: round 74)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new BookmarkError("A bookmark with that name already exists. Remove it first, or choose another name.");
    throw e;
  }
  return b;
}

export function remove(name: string): void {
  checkName(name);
  const d = folder(false);
  const file = d ? path.join(d, name + ".json") : "";
  let st: fs.Stats | null = null;
  try {
    if (d) st = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (!st) throw new BookmarkError("There is no bookmark with that name.");
  if (!st.isFile()) throw new BookmarkError("That bookmark is not a plain file (a link or a folder). Not touching it.");
  fs.rmSync(file);
  removeItem(d!, name + FP);
}

export function setWatch(name: string, watch: boolean): Bookmark {
  checkName(name);
  const d = folder(false);
  const b = d ? readOne(d, name) : null;
  if (!b) throw new BookmarkError("There is no bookmark with that name.");
  const next = { ...b, watch };
  writeItem(d!, name + ".json", JSON.stringify({ v: 1, name: next.name, url: next.url, watch: next.watch, added_at: next.added_at }), "replace");
  return next;
}

// v0.5.1: remember a watched page's fingerprint in its bookmark (the watch baseline). A bookmark removed
// meanwhile is not brought back.
// The fingerprint lives in its own file, <name>.fp.json (Codex round 73): writing it never rewrites the
// bookmark, so a bookmark removed meanwhile can never come back; at worst a stray .fp.json is left, which
// is not a bookmark (and is replaced or removed with the next bookmark of that name).
const FP = ".fp.json";
// Bound to the bookmark it was taken for (Codex round 75): `of` is that bookmark as the watch read it; if
// the name now holds another bookmark (removed and added again), nothing is written, and a fingerprint
// file is only ever used with the bookmark whose added_at it carries.
export function setFingerprint(name: string, fp: string, of?: { url: string; added_at: string }): void {
  checkName(name);
  const d = folder(false);
  const b = d ? readOne(d, name) : null;
  if (!b || b.last_fingerprint === fp) return;
  if (of && (of.url !== b.url || of.added_at !== b.added_at)) return;
  writeItem(d!, name + FP, JSON.stringify({ v: 1, fp, added_at: b.added_at }), "replace");
}

// All bookmarks, by name. A damaged file is counted, not fatal. At most MAX_BOOKMARKS files
// are read; any beyond that (only possible by hand or a race) are counted in `not_read`.
export function list(): { items: Bookmark[]; damaged: number; not_read: number } {
  const d = folder(false);
  if (!d) return { items: [], damaged: 0, not_read: 0 };
  const all = names(d);
  const items: Bookmark[] = [];
  let damaged = 0;
  for (const n of all.slice(0, MAX_BOOKMARKS)) {
    try {
      const b = readOne(d, FILE.exec(n)![1]);
      if (b) items.push(b);
    } catch {
      damaged++;
    }
  }
  return { items, damaged, not_read: Math.max(0, all.length - MAX_BOOKMARKS) };
}
