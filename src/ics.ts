// SPDX-License-Identifier: Apache-2.0
// v0.6 (track "files"), item 3: calendar invites (.ics) as structured events. Read from the text the
// calendar reader already has (folded lines joined), in the worker like every page parse. Each event gives
// its summary, start, end, organizer, location, description and URL, every value bounded; its links are
// listed as untrusted and never followed (Safe Browsing checks any of them before a visit, like any page
// link). Nothing in an invite is acted on: no reply is sent, nothing is added to any calendar.
//
// One linear pass over the lines; a fixed cap on events kept and on nesting depth.
import { MAX_URL } from "./types.js";

export const MAX_EVENTS = 50; // events kept from one file (the rest are counted)
export const MAX_DEPTH = 20; // nested BEGIN blocks followed
export const MAX_EVENT_LINKS = 20;
const CAP = { summary: 300, location: 300, organizer: 300, organizer_name: 200, description: 1000, date: 64, tz: 100, status: 40, rule: 300 };
const SINGLE = new Set(["SUMMARY", "DTSTART", "DTEND", "DURATION", "ORGANIZER", "LOCATION", "DESCRIPTION", "URL", "UID", "STATUS", "RECURRENCE-ID", "RRULE"]);
const URI_PROPS = new Set(["URL", "ATTACH", "CONFERENCE", "X-GOOGLE-CONFERENCE", "X-MICROSOFT-SKYPETEAMSMEETINGURL", "ORGANIZER", "ATTENDEE"]); // values that are URIs (CAL-ADDRESS too)

export interface CalEvent {
  summary?: string;
  start?: string; // ISO 8601 when the value has the usual form, otherwise as written (bounded)
  start_tz?: string; // the TZID the start names, as written
  end?: string;
  end_tz?: string;
  duration?: string; // when the event gives a DURATION instead of an end
  organizer?: string; // the address, "mailto:" dropped
  organizer_name?: string; // its CN
  location?: string;
  description?: string;
  url?: string;
  // Status and recurrence, as written (Codex round 3): a cancelled event must not look active, and a changed
  // occurrence must not look like an unrelated event. Recurrences are never expanded.
  status?: string; // STATUS (TENTATIVE, CONFIRMED, CANCELLED...)
  uid?: string; // UID: ties a changed occurrence (recurrence_id) to its series
  method?: string; // its calendar's METHOD (REQUEST, CANCEL...); each calendar object in the file has its own
  rrule?: string; // RRULE
  rdate?: string; // RDATE lines, each as "TZID=<zone>:<values>" or "<values>", joined with ";" (Codex round 6)
  exdate?: string; // EXDATE lines, the same way: each line keeps its own time zone
  recurrence_id?: string; // RECURRENCE-ID: this event replaces one occurrence of another
  recurrence_id_tz?: string; // its TZID
  recurrence_range?: string; // its RANGE (THISANDFUTURE: the change applies to later occurrences too)
  links?: string[]; // every http(s) link in the event (any property's value or parameter), never followed
  links_omitted?: number; // links past the cap of 20 or longer than 2,048 characters, counted
  cut?: true; // a value was longer than its cap and was cut
}

type Lost = { n: number; seen: Set<string> };

// RFC 5545 text escapes: \n or \N is a line break; \, \; \\ are the characters.
const unescape = (v: string) => v.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));

// "20261024T170000Z" -> "2026-10-24T17:00:00Z"; "20261024" -> "2026-10-24"; anything else as written.
export function isoDate(v: string): string {
  const s = v.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}`;
  return s; // as written (the caller bounds it)
}

// http(s) links written in a value, found with indexOf (linear), each checked with the URL parser. Links
// past the cap or too long are counted in `lost.n` (Codex round 1: an inventory never looks complete when
// it is not).
function linksIn(v: string, into: Set<string>, lost: Lost): void {
  const re = /https?:\/\//gi; // the scheme in any case (Codex round 2)
  for (;;) {
    const m = re.exec(v);
    if (!m) return;
    const s = m.index;
    let e = s;
    while (e < v.length && !/[\s"'<>\\]/.test(v[e])) e++;
    const raw = v.slice(s, e).replace(/[.,;:)]+$/, ""); // free text: punctuation after a link is the sentence's
    re.lastIndex = Math.max(e, s + 1);
    addLink(raw, into, lost);
  }
}
// One link, parsed as given. Returns its normalized form when it is an http(s) link.
function addLink(raw: string, into: Set<string>, lost: Lost): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!into.has(u.href)) {
      if (u.href.length > MAX_URL || into.size >= MAX_EVENT_LINKS) {
        if (!lost.seen.has(u.href)) {
          lost.seen.add(u.href); // each omitted link is counted once, however often it appears
          lost.n++;
        }
      } else into.add(u.href);
    }
    return u.href;
  } catch {
    return null; // not a URL
  }
}
// A URI-valued property or parameter: the whole value is the link, kept exactly (no punctuation taken off);
// a value that is not one URI is searched like free text.
function uriValue(v: string, into: Set<string>, lost: Lost): string | null {
  const t = v.trim();
  if (/^https?:\/\//i.test(t) && !/\s/.test(t)) {
    const h = addLink(t, into, lost);
    if (h) return h;
  }
  linksIn(t, into, lost);
  return null;
}

// One content line: NAME;PARAM=...;PARAM="...":VALUE. The value starts at the first ":" outside quotes.
function splitLine(line: string): { name: string; params: Map<string, string>; items: string[]; value: string } | null {
  let i = 0;
  while (i < line.length && line[i] !== ";" && line[i] !== ":") i++;
  const name = line.slice(0, i).trim().toUpperCase();
  const params = new Map<string, string>();
  const all: string[] = []; // every parameter list item, decoded (for links)
  while (i < line.length && line[i] === ";") {
    i++;
    const ks = i;
    while (i < line.length && line[i] !== "=" && line[i] !== ";" && line[i] !== ":") i++;
    const key = line.slice(ks, i).trim().toUpperCase();
    // A parameter's value is a comma-separated list, each item quoted or not (RFC 5545 3.1); items are
    // joined with commas, and RFC 6868 caret escapes are decoded (Codex round 5).
    const items: string[] = [];
    // A parameter without a value, or one given twice, makes the line malformed (Codex round 10).
    if (line[i] !== "=" || !key || params.has(key)) return null;
    {
      i++;
      for (;;) {
        if (line[i] === '"') {
          const e = line.indexOf('"', i + 1);
          if (e === -1) return null;
          items.push(line.slice(i + 1, e));
          i = e + 1;
        } else {
          const vs = i;
          while (i < line.length && line[i] !== ";" && line[i] !== ":" && line[i] !== ",") i++;
          items.push(line.slice(vs, i));
        }
        if (line[i] !== ",") break;
        i++;
      }
    }
    const decoded = items.map((x) => x.replace(/\^(n|\^|')/g, (_m, c: string) => (c === "n" ? "\n" : c === "^" ? "^" : '"')));
    all.push(...decoded); // every item is searched for links (Codex round 6); the line's length bounds them
    const val = decoded.join(",");
    if (key && !params.has(key)) params.set(key, val);
  }
  if (line[i] !== ":" || !name) return null;
  return { name, params, items: all, value: line.slice(i + 1) };
}

export function parseEvents(text: string): { events: CalEvent[]; total: number; malformed: boolean } {
  const events: CalEvent[] = [];
  let total = 0;
  let malformed = false;
  const stack: string[] = [];
  let cur: CalEvent | null = null;
  let links = new Set<string>();
  let lost: Lost = { n: 0, seen: new Set() };
  let depthLost = 0; // BEGINs past MAX_DEPTH, not followed
  type Field = "summary" | "location" | "organizer" | "organizer_name" | "description" | "start" | "end" | "start_tz" | "end_tz" | "duration" | "status" | "rrule" | "rdate" | "exdate" | "recurrence_id" | "uid" | "recurrence_id_tz" | "recurrence_range";
  const CAPS: Record<Field, number> = {
    ...CAP, start: CAP.date, end: CAP.date, duration: CAP.date, start_tz: CAP.tz, end_tz: CAP.tz, rrule: CAP.rule, rdate: CAP.rule, exdate: CAP.rule,
    recurrence_id: CAP.date, uid: CAP.rule, recurrence_id_tz: CAP.tz, recurrence_range: CAP.status,
  };
  // The METHOD of the calendar object being read, and the events kept from it (Codex round 4: a stream may
  // hold several calendar objects, each with its own method).
  let method: string | undefined;
  let methodCut = false;
  let calEvents: CalEvent[] = [];
  const endCalendar = () => {
    if (method !== undefined)
      for (const e of calEvents) {
        e.method = method;
        if (methodCut) e.cut = true;
      }
    method = undefined;
    methodCut = false;
    calEvents = [];
  };
  // A list property that may repeat (EXDATE, RDATE): every value counts, joined, within its cap.
  const append = (k: "rdate" | "exdate", v: string) => {
    if (!cur) return;
    const all = cur[k] === undefined ? v : `${cur[k]};${v}`;
    if (all.length > CAPS[k]) cur.cut = true;
    cur[k] = all.slice(0, CAPS[k]);
  };
  // Every bounded value goes through here, so any cut sets `cut` (Codex round 1). The first value counts.
  const put = (k: Field, v: string) => {
    if (!cur || cur[k] !== undefined) return;
    const cap = CAPS[k];
    if (v.length > cap) cur.cut = true;
    cur[k] = v.slice(0, cap);
  };
  const close = () => {
    if (!cur) return;
    if (links.size) cur.links = [...links];
    if (lost.n) cur.links_omitted = lost.n;
    // DTEND and DURATION exclude each other: the end is kept and the file is malformed (Codex round 11).
    if (cur.end !== undefined && cur.duration !== undefined) {
      delete cur.duration;
      malformed = true;
    }
    if (events.length < MAX_EVENTS) {
      events.push(cur);
      calEvents.push(cur);
    }
    cur = null;
  };
  let seenProps = new Set<string>();
  let eventDepth = 0; // the stack depth at which the current event's own properties sit
  for (const line of text.split(/\r\n|\n|\r/)) {
    const p = splitLine(line);
    if (!p) {
      if (line.trim()) malformed = true; // a line that is not NAME:VALUE is skipped, and said (Codex round 2)
      continue;
    }
    if (p.name === "BEGIN") {
      if (stack.length >= MAX_DEPTH) {
        depthLost++;
        malformed = true; // nesting past the cap is not followed
        continue;
      }
      if (depthLost) {
        depthLost++; // inside a block that is not followed, every nested block is not followed either
        continue;
      }
      const comp = p.value.trim().toUpperCase().slice(0, 40);
      if (comp === "VCALENDAR" && stack.length === 0) endCalendar();
      stack.push(comp);
      if (comp === "VEVENT") {
        if (cur) malformed = true; // an event inside an event: its properties are not the outer event's
        else {
          total++;
          cur = {};
          links = new Set();
          lost = { n: 0, seen: new Set() };
          eventDepth = stack.length;
          seenProps = new Set();
        }
      }
      continue;
    }
    if (p.name === "END") {
      if (depthLost) {
        depthLost--;
        continue;
      }
      // END must name the open block; one that names a block further out closes everything up to it, and
      // one that names no open block is ignored. Either is malformed (Codex round 1).
      const comp = p.value.trim().toUpperCase().slice(0, 40);
      const at = stack.lastIndexOf(comp);
      if (at === -1) {
        malformed = true;
        continue;
      }
      if (at !== stack.length - 1) malformed = true;
      stack.length = at;
      if (cur && stack.length < eventDepth) close();
      continue;
    }
    if (p.name === "METHOD" && stack.length === 1 && stack[0] === "VCALENDAR" && method !== undefined) malformed = true; // a second METHOD (Codex round 11)
    if (p.name === "METHOD" && stack.length === 1 && stack[0] === "VCALENDAR" && method === undefined) {
      method = p.value.trim();
      methodCut = method.length > CAP.status; // a cut method marks its events cut (Codex round 7)
      method = method.slice(0, CAP.status);
    }
    // Properties of the event itself only (not of an alarm, a nested event or any other block inside it,
    // nor of a block past the depth cap).
    if (depthLost || !cur || stack.length !== eventDepth) continue;
    const v = p.value;
    // Links: from EVERY property's value and every parameter (ALTREP, DIR, SENT-BY...), whatever the property
    // (Codex round 3: the list never looks complete when it is not).
    for (const pv of p.items) if (/https?:\/\//i.test(pv)) uriValue(pv, links, lost);
    // A URI value (by its property, or VALUE=URI) is taken whole; any other value is searched as text (Codex round 9).
    const isUri = URI_PROPS.has(p.name) || (p.params.get("VALUE") ?? "").toUpperCase() === "URI";
    if (isUri) uriValue(v, links, lost);
    else linksIn(unescape(v), links, lost);
    // A property that may appear once, appearing again: the first one wins, whole (value and parameters
    // together), and the file is malformed (Codex round 8).
    if (SINGLE.has(p.name)) {
      if (seenProps.has(p.name)) {
        malformed = true;
        continue;
      }
      seenProps.add(p.name);
    }
    switch (p.name) {
      case "SUMMARY":
        put("summary", unescape(v));
        break;
      case "LOCATION":
        put("location", unescape(v));
        linksIn(unescape(v), links, lost);
        break;
      case "DESCRIPTION":
        put("description", unescape(v));
        linksIn(unescape(v), links, lost);
        break;
      case "DTSTART":
      case "DTEND": {
        const k = p.name === "DTSTART" ? "start" : "end";
        if (cur[k] !== undefined) break;
        put(k, isoDate(v));
        const tz = p.params.get("TZID");
        if (tz) put(`${k}_tz`, tz);
        break;
      }
      case "DURATION":
        put("duration", v.trim());
        break;
      case "STATUS":
        put("status", v.trim());
        break;
      case "RRULE":
        put("rrule", v.trim());
        break;
      case "RDATE":
      case "EXDATE": {
        const k = p.name === "RDATE" ? "rdate" : "exdate";
        const tz = p.params.get("TZID");
        if (tz && tz.length > CAP.tz) cur.cut = true;
        append(k, (tz ? `TZID=${tz.slice(0, CAP.tz)}:` : "") + v.trim());
        break;
      }
      case "RECURRENCE-ID": {
        put("recurrence_id", isoDate(v));
        const tz = p.params.get("TZID");
        if (tz) put("recurrence_id_tz", tz);
        const range = p.params.get("RANGE");
        if (range) put("recurrence_range", range);
        break;
      }
      case "UID":
        put("uid", unescape(v)); // a TEXT value: escapes decoded, white space kept (Codex round 8)
        break;
      case "ORGANIZER": {
        const addr = v.trim().replace(/^mailto:/i, "");
        put("organizer", addr);
        const cn = p.params.get("CN");
        if (cn) put("organizer_name", cn);
        break;
      }
      case "URL":
      case "ATTACH":
      case "CONFERENCE":
      case "X-GOOGLE-CONFERENCE":
      case "X-MICROSOFT-SKYPETEAMSMEETINGURL": {
        // The value is the link, kept exactly; the event's URL is its own value, whatever the link list
        // already holds (Codex rounds 1 and 2).
        const h = uriValue(v, links, lost);
        if (p.name === "URL" && cur.url === undefined && h && h.length <= MAX_URL) cur.url = h;
        break;
      }
    }
  }
  // An event never closed (a cut-off file) is still an event; any block left open makes the file malformed.
  if (stack.length || depthLost) malformed = true;
  if (cur) {
    malformed = true;
    close();
  }
  endCalendar();
  return { events, total, malformed };
}
