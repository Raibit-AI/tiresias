// SPDX-License-Identifier: Apache-2.0
// Known GET form targets are policy, not a guess about what an arbitrary GET does.
import { loadChoice } from "./config.js";
import { Refused } from "./errors.js";
import { cachePath, homeDir, isPrivate, readJson, sha256, writeJson } from "./store.js";
import { normalizePath } from "./rules.js";
import { callContext } from "./context.js";
import { claimSlip, claimedStillValid } from "./slips.js";

type Form = { method: string; action: string | null };
const shared = { seen: new Set<string>() };
const MAX_SEEN = 4096;
// Every shared overflow target enters this fixed 8 KiB Bloom filter, saved or not.
// With 65,536 bits and 4 probes, estimated false positive rates (uniform hashes) are
// 0.239% at 4,096, 16.0% at 16,384 and 92.9% at 65,536 overflow targets. No false
// negatives during this process; collisions only require extra slips. Private observations never enter it.
const sharedOverflow = new Uint8Array(8192);
function overflowBits(key: string): number[] {
  const hash = sha256(key);
  return [0, 4, 8, 12].map((i) => parseInt(hash.slice(i, i + 4), 16));
}
function inSharedOverflow(key: string): boolean {
  return overflowBits(key).every((bit) => (sharedOverflow[bit >>> 3] & (1 << (bit & 7))) !== 0);
}
// A denial comparison, never a URL to send or a permission-slip scope. Reuse the robots path
// normalizer for unreserved octets and escape case, then fold ambiguous server routing spellings
// conservatively: repeated decoding, separators, path parameters, Unicode, case and dot segments.
// At a fixed point, keep only Unicode letters and digits per segment, dropping empty segments.
// URL already handles IDNA, IP spellings, host case and default ports. No DNS alias guessing.
export function getActionTarget(u: URL): string {
  const host = new URL(u.origin);
  host.hostname = host.hostname.replace(/\.+$/, "");
  let path = normalizePath(u.pathname);
  // Repeat the whole fold: NFKC itself can introduce a fresh percent escape.
  // Bound nested encoding work; the wildcard is a denial key for the entire origin.
  for (let i = 0; i < 64; i++) {
    let next = path.replace(/(?:%[0-9a-f]{2})+/gi, (s) => {
      try { return decodeURIComponent(s); }
      catch { return s.replace(/%([0-7][0-9a-f])/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))); }
    });
    // URL parsers remove these controls before resolving dot segments and escapes.
    next = next.replace(/[\t\n\r]/g, "");
    next = next.normalize("NFKC").toLowerCase().replace(/\\/g, "/").split(/[?#\0]/)[0];
    const parts: string[] = [];
    for (const part of next.split("/")) {
      const seg = part.split(";")[0].replace(/ +$/, "");
      if (seg === "..") parts.pop();
      // Keep dots until nested escapes can expose a dot segment, such as .%2509.
      else if (seg && seg !== ".") parts.push(/%[0-9a-f]{2}/i.test(seg) ? seg : seg.replace(/[. ]+$/, ""));
    }
    next = "/" + parts.filter(Boolean).join("/");
    if (next === path) {
      // Preserve the origin wildcard, including when a denial key is folded again.
      if (next === "/*") return `${host.origin}/*`;
      next = "/" + next.split("/").map((seg) => seg.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean).join("/");
      if (next === path) return `${host.origin}${next}`;
      // Removing punctuation can join Unicode letters that then compose under NFKC.
      // Converge again within the same bound so the final denial key stays idempotent.
    }
    path = next;
  }
  return `${host.origin}/*`;
}
// Inputs are already folded, so a renderer folds its request only once.
export function getActionTargetsMatch(a: string, b: string): boolean {
  return a === b || ((a.endsWith("/*") || b.endsWith("/*")) && new URL(a).origin === new URL(b).origin);
}

const actionKey = (u: URL) => `get-form:${getActionTarget(u)}`;
function observations() {
  if (!isPrivate()) return shared;
  const ctx = callContext.getStore();
  // A caller without a call scope must never put private observations in shared memory.
  return ctx ? (ctx.getActions ??= { seen: new Set<string>(), full: false }) : undefined;
}
const memoryKey = (key: string) => `${homeDir()}\0${key}`;

export function noteGetActions(forms: Form[] = [], keep = false): void {
  const state = observations();
  for (const f of forms) {
    if (f.method !== "GET" || !f.action) continue;
    const key = actionKey(new URL(f.action));
    const mk = memoryKey(key);
    const saved = keep && !isPrivate() && !callContext.getStore()?.readOnly;
    if (state && !state.seen.has(mk)) {
      if (state.seen.size < MAX_SEEN) state.seen.add(mk);
      else if (state === shared) for (const bit of overflowBits(mk)) sharedOverflow[bit >>> 3] |= 1 << (bit & 7);
      else if ("full" in state) state.full = true; // private overflow fails closed only for this call
    }
    // Record policy in memory before writing, so a failed write also fails closed.
    if (saved) writeJson(cachePath(key), { get_form_action: true, fetched_at: new Date().toISOString() });
  }
}

export function guardGetAction(u: URL): void {
  if (loadChoice("get_form_actions") !== "slip") return;
  const target = getActionTarget(u);
  const key = `get-form:${target}`;
  const state = callContext.getStore()?.getActions;
  const wildcard = `get-form:${new URL(target).origin}/*`;
  const known = key === wildcard || [key, wildcard].some((k) => inSharedOverflow(memoryKey(k))) || state?.full || [state, shared].some((s) => s?.seen.has(memoryKey(key)) || s?.seen.has(memoryKey(wildcard))) ||
    [key, wildcard].some((k) => readJson<{ get_form_action?: boolean }>(cachePath(k))?.get_form_action === true);
  if (!known) return;
  const claim = claimSlip("submit_form", u.href, "get_form_action");
  if ("refused" in claim || !claimedStillValid(claim, "submit_form", u.href))
    throw new Refused("This GET needs a current submit_form permission slip: its target matches an observed form action, or the observation limit was reached. Nothing was sent.");
}
