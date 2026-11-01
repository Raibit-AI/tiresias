// SPDX-License-Identifier: Apache-2.0
// v0.5.1: ONE ambient context per call. It replaces the two that grew apart (safety.ts's call scope and
// store.ts's private flag), so "what call am I in, and is it private" has one answer everywhere.
import { AsyncLocalStorage } from "node:async_hooks";

export interface CallContext {
  signal?: AbortSignal; // MCP cancellation plus the call's overall deadline
  private?: boolean; // W-14: the call keeps nothing (store writes refuse; see store.ts)
  robots?: Map<string, unknown>; // robots.txt kept for this call only, when the site said no-store
  sent?: { requests: number; signed: number }; // N-07: how many requests this call sent, and how many were signed
  // W-19: the Safe Browsing check for this call. Called with every hop's URL BEFORE anything is sent
  // to it (robots.txt, probes, the page, each redirect); it throws to stop the call.
  gate?: (u: URL) => Promise<void>;
  // W-21: quarantine files written during this call. Each is deleted after its scanner hook returns, and
  // whatever is left (a call that failed or was cancelled in between) is deleted when the call ends.
  quarantine?: Set<string>;
  readOnly?: boolean; // a call that writes nothing (form_preview): not even the shared spacing file
  site?: Set<import("./types.js").SiteSettingCode>;
  // W-25 (v0.6, coordinator's rule after Codex round 11): the site settings, read ONCE when the call started and
  // kept for the whole call. A change saved meanwhile applies to calls that start after it.
  sites?: Record<string, import("./sites.js").SiteRule>;
  // W-10 (v0.7, Banks after Codex round 3): the byte budget of a render, set only for the requests a render makes. Every
  // byte fetched on the render's behalf is charged to it, robots.txt included (rules.ts).
  renderBudget?: { take(bytes: number): boolean; release(reserved: number, charged: number): void }; // W-25 (v0.6): the owner's site settings that applied to this call
}
export const callContext = new AsyncLocalStorage<CallContext>();
