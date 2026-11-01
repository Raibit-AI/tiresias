// SPDX-License-Identifier: Apache-2.0
// v0.5.1: one helper for "one JSON file per item in a checked folder" (bookmarks, handoff tickets, slips).
// Every write goes to an exclusive temp file in the same folder (0600, never through a link), is written
// whole and fsynced, and is then linked to its name (create: fails if the name is taken) or renamed over
// it (replace). So a name either does not exist or holds a whole file, and nothing is written in place.
// Every read opens the file without following links and without blocking, checks it is a regular file of
// ours, and caps its size before parsing. Writes refuse in a private call (store.ts, fails closed).
import fs from "node:fs";
import path from "node:path";
import { NOFOLLOW, NONBLOCK, PRIVATE_WRITE, PrivateWriteError, isPrivate, ownFile, randomTmp } from "./store.js";

export type ReadTrouble = "unreadable" | "too_large" | "damaged";

// The parsed JSON at dir/name, or null when there is no such file. Anything else wrong calls `fail` with
// why, and throws what it returns.
export function readItem(dir: string, name: string, maxBytes: number, fail: (why: ReadTrouble) => Error): unknown {
  const file = path.join(dir, name);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw fail("unreadable");
  }
  try {
    try {
      ownFile(fd, file);
    } catch {
      throw fail("unreadable");
    }
    if (fs.fstatSync(fd).size > maxBytes) throw fail("too_large");
    try {
      return JSON.parse(fs.readFileSync(fd, "utf8"));
    } catch {
      throw fail("damaged");
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Write `text` as dir/name. "create" fails with an EEXIST error when the name is taken; "replace" puts it
// in place of what is there in one rename.
export function writeItem(dir: string, name: string, text: string, how: "create" | "replace"): void {
  if (isPrivate()) throw new PrivateWriteError(PRIVATE_WRITE);
  const file = path.join(dir, name);
  const tmp = randomTmp(file);
  const buf = Buffer.from(text);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW | NONBLOCK, 0o600);
  try {
    try {
      for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off, buf.length - off);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (how === "create") fs.linkSync(tmp, file);
    else fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true }); // after a link the temp name is a second name; after a rename it is gone
  }
}

// Delete dir/name if it is a plain regular file. Returns whether something was there.
export function removeItem(dir: string, name: string): boolean {
  const file = path.join(dir, name);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return false;
  }
  if (st.isFile()) fs.rmSync(file, { force: true });
  return true;
}
