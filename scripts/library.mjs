// SPDX-License-Identifier: Apache-2.0
// The meaning check's library is kept as two lists (the owner's rule, 2026-11-14):
//
//   data/        the released list: what the current build ships and what `tiresias guard setup` reads
//   data-next/   the working list: the only one anybody edits between builds
//
// New examples of planted text go into data-next/ as they are found. Whatever differs between the two is what the
// next build will carry. At a build the working list is checked and copied over the released one, so the two are
// the same in every release: the release workflow stops while they differ.
//
//   node scripts/library.mjs status     what the next build would change (counts by kind; never prints a text)
//   node scripts/library.mjs check      is the working list well formed?
//   node scripts/library.mjs release    check, then make data/ the same as data-next/
//   node scripts/library.mjs gate       exit 1 unless the two lists are the same (a step in the release workflow)
//
// LIBRARY_ROOT points the script at another folder that holds data/ and data-next/ (the tests use it).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.LIBRARY_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASED = path.join(root, "data");
const NEXT = path.join(root, "data-next");
// The files kept in step. The README in each folder is its own and is not compared.
export const FILES = ["guard-starter.jsonl", "guard-ordinary-urls.txt"];
// The same kinds, and the same bounds on a text, as src/guard.ts (a test holds the two together).
export const KINDS = ["override", "fake_system", "fake_user", "fake_tool", "fake_assistant", "chat_marks", "send_out", "reply_shape", "favour", "task_changed", "fake_rule", "urgency", "persona", "secrecy", "conditional"];
export const MIN_TEXT = 10;
export const MAX_TEXT = 4_000;
export const MIN_STARTER = 100;
export const MAX_STARTER = 30_000;
export const MAX_STARTER_BYTES = 32 * 1024 * 1024;
export const MAX_URL_BYTES = 1024 * 1024;
export const MAX_URLS = 1_000;
export const MIN_URLS = 20;
const MAX_LINE = 32 * 1024;
const MAX_PROBLEMS = 100;

const norm = (t) => t.trim().replace(/\s+/g, " ");
class LibraryError extends Error {}
// Bound reads before allocating or decoding. Reject replacement decoding: the loader must see the bytes checked.
function read(dir, name) {
  const max = name === FILES[0] ? MAX_STARTER_BYTES : MAX_URL_BYTES;
  let fd;
  try {
    fd = fs.openSync(path.join(dir, name), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new LibraryError(`${name}: must be a regular file.`);
    if (st.size > max) throw new LibraryError(`${name}: file exceeds ${max} bytes.`);
    const bytes = Buffer.alloc(st.size + 1);
    let n = 0, got;
    while (n < bytes.length && (got = fs.readSync(fd, bytes, n, bytes.length - n, null))) n += got;
    if (n !== st.size) throw new LibraryError(`${name}: file changed while being read.`);
    const buffer = bytes.subarray(0, n);
    try { new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); }
    catch { throw new LibraryError(`${name}: must be valid UTF-8.`); }
    return buffer;
  } catch (e) {
    if (e instanceof LibraryError) throw e;
    throw new LibraryError(`${name}: could not read the file.`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
const snapshot = (dir) => FILES.map((f) => read(dir, f));
// Iteration avoids a large array for a file made mostly of blank lines.
function* lines(text) {
  let start = 0;
  while (start < text.length) {
    const end = text.indexOf("\n", start);
    yield text.slice(start, end < 0 ? text.length : end);
    if (end < 0) break;
    start = end + 1;
  }
}
function diagnostics() {
  const problems = [];
  const report = (p) => {
    if (problems.length < MAX_PROBLEMS) problems.push(p);
    else if (problems.length === MAX_PROBLEMS) problems.push("Further problems omitted.");
  };
  return { problems, report };
}

// What a planted text may ask for: stand-ins only, so that no example can send a reader anywhere real. An address
// must be on `.example`; a phone number must be one of 555-0100 to 555-0199.
function standIns(text) {
  const bad = [];
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s"'<>)\]]+/gi)) {
    let u;
    try { u = new URL(m[0]); } catch { /* An invalid address is not a stand-in. */ }
    if (!u || !/\.example$/i.test(u.hostname.replace(/\.$/, ""))) bad.push("an address that is not on .example");
  }
  for (const m of text.matchAll(/\b([a-z0-9-]+\.)+(com|net|org|io|ai|co|dev|app|xyz|info|biz|me|ly|gg|ru|cn|uk|de|fr)\b/gi)) bad.push(`a real-looking site name (${m[0].length} characters)`);
  for (const m of text.matchAll(/\b\d{3}[-. ]\d{4}\b/g)) if (!/^555-01\d\d$/.test(m[0])) bad.push("a phone number outside 555-0100 to 555-0199");
  return bad;
}

// Problems in a starter file, as plain sentences that name the line and never repeat its text.
export function checkStarter(text) {
  const { problems, report } = diagnostics();
  const seen = new Map();
  let n = 0, i = 0;
  for (const line of lines(text)) {
    i++;
    if (!line.trim()) continue;
    if (++n > MAX_STARTER) { report(`guard-starter.jsonl has more than ${MAX_STARTER} texts.`); break; }
    const where = `guard-starter.jsonl line ${i}`;
    if (line.length > MAX_LINE) { report(`${where}: line exceeds ${MAX_LINE} characters.`); continue; }
    let o;
    try { o = JSON.parse(line); } catch { report(`${where}: not JSON.`); continue; }
    if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).sort().join() !== "kind,text") { report(`${where}: must be an object with exactly "text" and "kind".`); continue; }
    if (!KINDS.includes(o.kind)) report(`${where}: unknown kind.`);
    if (typeof o.text !== "string" || o.text.length > MAX_TEXT || norm(o.text).length < MIN_TEXT) {
      report(`${where}: the text must be ${MIN_TEXT} to ${MAX_TEXT} characters.`);
      continue;
    }
    // Lone surrogates become replacement characters when the guard hashes or sends the text as UTF-8.
    if (!o.text.isWellFormed()) { report(`${where}: the text must have well-formed Unicode.`); continue; }
    for (const b of standIns(o.text)) report(`${where}: carries ${b}.`);
    const key = norm(o.text).toLowerCase();
    if (seen.has(key)) report(`${where}: the same text as line ${seen.get(key)}.`);
    else seen.set(key, i);
  }
  if (n < MIN_STARTER) report(`guard-starter.jsonl has ${n} texts; the check needs at least ${MIN_STARTER}.`);
  return problems;
}
export function checkUrls(text) {
  const { problems, report } = diagnostics();
  const seen = new Set();
  let n = 0, i = 0;
  for (const line of lines(text)) {
    i++;
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    if (++n > MAX_URLS) { report(`guard-ordinary-urls.txt has more than ${MAX_URLS} addresses.`); break; }
    const where = `guard-ordinary-urls.txt line ${i}`;
    let u;
    try { u = new URL(l); } catch { report(`${where}: not an address.`); continue; }
    // readUrlList requires the slashes literally; URL alone accepts https:host and https:/host.
    if (!/^https:\/\//i.test(l) || u.protocol !== "https:" || u.username || u.password || /[\u0000-\u0020\u007f\\]/.test(l)) report(`${where}: must be a plain https address.`);
    if (seen.has(u.href)) report(`${where}: listed twice.`);
    seen.add(u.href);
  }
  if (seen.size < MIN_URLS) report(`guard-ordinary-urls.txt has ${seen.size} distinct addresses; setup needs at least ${MIN_URLS} ordinary pages.`);
  return problems;
}
const checkSnapshot = (files) => [...checkStarter(files[0].toString("utf8")), ...checkUrls(files[1].toString("utf8"))];
export const checkAll = (dir) => checkSnapshot(snapshot(dir));

// What differs, counted and never quoted: the lists hold hostile text, and this output is read by people and models.
export function status(aFiles = snapshot(RELEASED), bFiles = snapshot(NEXT)) {
  const out = { same: true, starter: { released: 0, next: 0, added: {}, removed: {} }, urls: { added: 0, removed: 0 } };
  const parse = (buffer) => {
    const entries = new Map();
    let n = 0;
    for (const line of lines(buffer.toString("utf8"))) {
      if (!line.trim()) continue;
      if (++n > MAX_STARTER) throw new LibraryError(`guard-starter.jsonl has more than ${MAX_STARTER} texts.`);
      if (line.length > MAX_LINE) throw new LibraryError(`guard-starter.jsonl: line exceeds ${MAX_LINE} characters.`);
      let o;
      try { o = JSON.parse(line); } catch { /* Count malformed lines without printing them. */ }
      const valid = o && typeof o.text === "string" && KINDS.includes(o.kind);
      const kind = valid ? o.kind : "unreadable";
      const key = JSON.stringify([valid ? norm(o.text) : line, kind]);
      const entry = entries.get(key) ?? { kind, count: 0 };
      entry.count++;
      entries.set(key, entry);
    }
    return entries;
  };
  const a = parse(aFiles[0]), b = parse(bFiles[0]);
  out.starter.released = [...a.values()].reduce((n, e) => n + e.count, 0);
  out.starter.next = [...b.values()].reduce((n, e) => n + e.count, 0);
  for (const [key, e] of b) {
    const added = e.count - (a.get(key)?.count ?? 0);
    if (added > 0) out.starter.added[e.kind] = (out.starter.added[e.kind] ?? 0) + added;
  }
  for (const [key, e] of a) {
    const removed = e.count - (b.get(key)?.count ?? 0);
    if (removed > 0) out.starter.removed[e.kind] = (out.starter.removed[e.kind] ?? 0) + removed;
  }
  const urls = (buffer) => {
    const found = new Set();
    let n = 0;
    for (const line of lines(buffer.toString("utf8"))) {
      const l = line.trim();
      if (!l || l.startsWith("#")) continue;
      if (++n > MAX_URLS) throw new LibraryError(`guard-ordinary-urls.txt has more than ${MAX_URLS} addresses.`);
      found.add(l);
    }
    return found;
  };
  const ua = urls(aFiles[1]), ub = urls(bFiles[1]);
  out.urls.added = [...ub].filter((x) => !ua.has(x)).length;
  out.urls.removed = [...ua].filter((x) => !ub.has(x)).length;
  out.same = aFiles.every((buffer, i) => buffer.equals(bFiles[i]));
  return out;
}
const count = (o) => Object.values(o).reduce((x, y) => x + y, 0);
const byKind = (o) => Object.entries(o).sort().map(([k, n]) => `${k} ${n}`).join(", ");
export function statusText(s = status()) {
  if (s.same) return `The working list and the released list are the same: ${s.starter.released} example texts. Nothing is waiting for the next build.`;
  const parts = [];
  if (count(s.starter.added)) parts.push(`${count(s.starter.added)} example texts added (${byKind(s.starter.added)})`);
  if (count(s.starter.removed)) parts.push(`${count(s.starter.removed)} removed (${byKind(s.starter.removed)})`);
  if (s.urls.added || s.urls.removed) parts.push(`ordinary pages: ${s.urls.added} added, ${s.urls.removed} removed`);
  return `Waiting for the next build: ${parts.join("; ") || "a change in formatting, comments or order only"}. Released ${s.starter.released} example texts, working list ${s.starter.next}.`;
}

// Stage the validated bytes together with the owner's other data files, then replace the whole directory.
// A failed install restores the old directory. Keep its backup if restoration itself fails.
function release(files) {
  const lock = path.join(root, ".library-release.lock");
  try { fs.mkdirSync(lock); } catch { throw new LibraryError("Another release holds .library-release.lock; finish or recover it first."); }
  let temp, moved = false;
  try {
    temp = fs.mkdtempSync(path.join(root, ".library-release-"));
    const staged = path.join(temp, "data"), backup = path.join(temp, "previous");
    fs.cpSync(RELEASED, staged, { recursive: true });
    for (const [i, f] of FILES.entries()) {
      fs.rmSync(path.join(staged, f), { force: true });
      fs.writeFileSync(path.join(staged, f), files[i], { flag: "wx" });
    }
    fs.renameSync(RELEASED, backup);
    moved = true;
    try { fs.renameSync(staged, RELEASED); }
    catch (e) {
      try { fs.renameSync(backup, RELEASED); moved = false; }
      catch { throw new LibraryError("Release recovery failed; the previous data directory remains in .library-release-*/previous."); }
      throw e;
    }
    moved = false;
  } finally {
    try { if (temp && !moved) fs.rmSync(temp, { recursive: true, force: true }); }
    finally { fs.rmdirSync(lock); }
  }
}

function main(cmd) {
  if (cmd === "status") console.log(statusText());
  else if (cmd === "check" || cmd === "release") {
    const files = snapshot(NEXT);
    const p = checkSnapshot(files);
    if (cmd === "check") {
      console.log(p.length ? p.join("\n") : "The working list is well formed.");
      return p.length ? 1 : 0;
    }
    if (p.length) { console.error(`${p.join("\n")}\nNot released: fix the working list first.`); return 1; }
    const before = statusText(status(snapshot(RELEASED), files));
    release(files);
    console.log(`${before}\nReleased: data/ now matches the checked working list. Run the tests and a guard setup before shipping.`);
  } else if (cmd === "gate") {
    if (fs.existsSync(path.join(root, ".library-release.lock"))) throw new LibraryError("A release is in progress; the gate is closed.");
    const released = snapshot(RELEASED), next = snapshot(NEXT);
    const s = status(released, next);
    const p = checkSnapshot(released);
    if (!s.same || p.length) { console.error(`${p.join("\n")}${p.length ? "\n" : ""}${statusText(s)}\nA build ships only when the two lists are the same: run node scripts/library.mjs release.`); return 1; }
    console.log(statusText(s));
  } else {
    console.error("Usage: node scripts/library.mjs status | check | release | gate");
    return 2;
  }
  return 0;
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv[2]); }
  catch (e) {
    console.error(e instanceof LibraryError ? e.message : "Library command failed: no release was completed.");
    process.exitCode = 1;
  }
}
