// SPDX-License-Identifier: Apache-2.0
// Error types shared across modules. Each maps to one envelope status.
import type { WallInfo } from "./walls.js";

// v0.5.1: every error Tiresias raises on purpose has this base and a fixed `kind`, so the engine maps an
// error to a reply by its kind (one switch) instead of instanceof lists kept in step by hand.
export type ErrorKind =
  | "safety" | "fetch" | "refused" | "wall" | "payment" | "signing" | "pdf" | "flagged" | "safe_browsing" | "slip"
  | "config" | "profile" | "complex" | "page_too_complex" | "provided" | "handoff" | "bookmark" | "private_write";
export abstract class TiresiasError extends Error {
  abstract readonly kind: ErrorKind;
}
// A bad setting (config.json or an environment variable). The message names the setting; it is never
// reported as "internal error".
export class ConfigError extends TiresiasError {
  readonly kind = "config";
}

// A request was refused for safety (private address, bad scheme). `detail`
// holds web-derived values (a redirect host); it goes inside untrusted_content.
export class SafetyError extends TiresiasError {
  readonly kind = "safety";
  constructor(message: string, public detail?: string) {
    super(message);
  }
}

export class FetchError extends TiresiasError {
  readonly kind = "fetch";
  constructor(
    message: string,
    public code: "timeout" | "too_large" | "network" | "too_many_redirects" | "cancelled" | "budget", // budget: W-10 (v0.7), a render's byte budget is spent
    public detail?: string,
  ) {
    super(message);
  }
}

// The site (or its robots.txt, or a cooldown) says no. Not a failure.
export class Refused extends TiresiasError {
  readonly kind = "refused";
  constructor(message: string, public retryAfter?: string, public retrySeconds?: number, public url?: string) {
    super(message);
  }
}

// Any request in a chain hit a wall. Everything stops.
export class Walled extends TiresiasError {
  readonly kind = "wall";
  constructor(public wall: WallInfo, public url: string) {
    super("wall");
  }
}

// Any request in a chain got a 402. We keep the evidence so the price can be read.
export class PaymentRequired extends TiresiasError {
  readonly kind = "payment";
  constructor(public headers: Headers, public body: string, public url: string) {
    super("payment required");
  }
}

// N-07: signing is set up but cannot be done (corrupt key, bad config). The call fails
// with this message; it never falls back to sending unsigned. The text is ours (no web
// content), and never contains key material.
export class SigningError extends TiresiasError {
  readonly kind = "signing";
}

// W-17: a PDF that cannot be read (damaged, password protected). The text is ours (no PDF content).
export class PdfError extends TiresiasError {
  readonly kind = "pdf";
}

// W-19: a Safe Browsing source flagged a URL this call was about to request. Nothing was sent to it.
// `codes` are fixed codes ("phishing_list", "web_risk:MALWARE", ...); `hard` is a Web Risk hit,
// which allow_flagged does not override. `url` is the URL that was flagged: the asked one or a
// redirect hop (web-derived), so it only ever goes inside untrusted_content.
export class Flagged extends TiresiasError {
  readonly kind = "flagged";
  constructor(public codes: string[], public hard: boolean, public url: string) {
    super("flagged");
  }
}

// W-19: Safe Browsing is set up but cannot be used as set up (a bad setting, an unsafe key file).
// Fixed text only: it never holds the key, the key file's contents or the Web Risk request URL.
export class SafeBrowsingError extends TiresiasError {
  readonly kind = "safe_browsing";
}

// W-05: a permission slip that cannot be granted, revoked or read (a bad scope, the slip key, the
// slips/ folder). The text is ours and never contains key material.
export class SlipError extends TiresiasError {
  readonly kind = "slip";
}

// A page with more elements than the reader walks (reader.ts MAX_NODES). Here, not in reader.ts, so the
// sandbox can raise it without importing the reader (v0.5.1).
export const MAX_NODES = 200_000;
export class ComplexityError extends TiresiasError {
  readonly kind = "complex";
  constructor() {
    super(`The page is too complex to read (more than ${MAX_NODES} elements).`);
  }
}
