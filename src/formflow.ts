// SPDX-License-Identifier: Apache-2.0
// W-04: forms as permission-gated actions (form_preview, form_submit).
// (Split out of engine.ts in v0.5.1, behavior unchanged.)
import { noteGetActions } from "./getactions.js";
import { assertSiteAllowed } from "./sites.js";
import { cooldownSeconds } from "./cooldown.js";
import path from "node:path";
import { COOLDOWN_TEXT, CRAWL_DELAY_TEXT, policyCheck, politeFetch, Refused } from "./fetcher.js";
import { shown } from "./reader.js";
import { runUntrusted } from "./sandbox.js";
import * as receipts from "./receipts.js";
import { assertPublicUrl, currentGate, currentSent, parseSafeUrl, throwIfCancelled, type FileFacts, type RawResponse } from "./safety.js";
import { CookieJar, HASH_RE, requestHasCard, MAX_FORMS, NOT_ALLOWED_TEXT, PROBLEM_TEXT, TOO_MANY_VALUES, buildRequest, publicForm, type Built, type FullForm } from "./forms.js";
import * as slips from "./slips.js";
import { stampProfile } from "./store.js";
import { PARSER_VERSION, type Ctx, type Envelope, type Flag, type FormTop, type Status } from "./types.js";
import { detectWall, parsePrice, type WallInfo } from "./walls.js";
import { SecretWithheld, noSecrets, rawTexts, secretsOf, valueHoldsSecret, type Secrets } from "./echo.js";

import { CallMeta, DEFAULT, Uc, env, guarded, sessionPrivate, wallEnv } from "./envelope.js";
import { fileOptions, fileWarning } from "./filereply.js";
import { CacheEntry } from "./pagecache.js";
import { buildContent, csvCount, detailOf, earlyOutcome, looksHtml, parsePage, recordReceipts, stampLanguage } from "./pipeline.js";

// ---- W-04: forms as permission-gated actions ----
//
// form_preview: fetch the page fresh (robots, waits, Safe Browsing and signing, like read with fresh),
// read its forms, check the agent's values, and show the EXACT request that would be sent, hidden
// values replaced by "[set by the site]", with a preview hash and whether a slip covers the target.
// Keeps no page record; shared politeness state still applies. A gated GET read can spend a slip use.
//
// form_submit: in ONE call, fetch the page fresh again, re-read the form, rebuild the request and its
// hash; a different hash is form_changed and nothing is sent. Then the TARGET is checked (Safe
// Browsing with no allow_flagged, the address checks, robots.txt, a Retry-After wait) and only then is
// one slip use claimed (claimSlip, as late as possible). The previewed request is sent once, never
// retried, with the hidden values from this fetch and only the cookies the site set during this call.
export const PREVIEW_OK =
  "This is exactly what form_submit would send: the method, the full URL and the encoded body. Fields the site set (hidden fields) are shown as [set by the site]; their real values are taken fresh when you submit and are never shown. Nothing was sent and nothing was written.";
export const PREVIEW_SLIP = " A permission slip covers this target (form.slip): submit with the same url, form and values plus form.preview_hash.";
export const PREVIEW_NO_SLIP =
  " No permission slip covers this target, so form_submit would refuse. Only the owner can grant one, from the command line (tiresias slip grant --action submit_form --site <origin> [--path <path>]): ask your person.";
export const NO_SUCH_FORM = "This page has no form with that number (forms are numbered from 1, in page order, at most 20). Read the page to see its forms.";
export const NOT_HTML = "This page is not an HTML page, so it has no forms Tiresias reads.";
export const FORM_CHANGED =
  "The form, or the request built from your values, is not what was previewed (the preview hash does not match). Nothing was sent. Preview again and check the new request.";
export const BAD_HASH = "preview_hash must be the 64-character form.preview_hash from form_preview. Nothing was fetched or sent.";
export const BAD_INDEX = "form must be a whole number from 1 to 20 (the form's index on the page).";
export const TOO_LARGE_REQUEST = "The request this form would make is too large to show exactly (a GET URL over 8,192 characters, a preview over 30,000 bytes, or a body over 1 MB). Nothing was sent.";
export const PRIVATE_SUBMIT =
  "Private mode: forms are not submitted, because a submit uses a permission slip, which writes a use and a record, and a private session writes nothing. Preview works in private mode.";
export const TARGET_REFUSED = "The address this form sends to may not be used now, so no slip was used and nothing was sent: ";
export const SENT = "The form was sent (one request, never retried).";
export const PAYMENT_VALUE = "Something in this request (the address, a name or a value) looks like a card number (13 to 19 digits passing the Luhn check), whether you gave it, the site set it or it is a default or a chosen option. Tiresias v0.x never pays, so nothing was sent.";

export type Loaded = { pageUrl: string; finalUrl: string; form: FullForm; flags: Flag[] };
export const isLoaded = (x: Loaded | Envelope): x is Loaded => "form" in x && !("status" in x);

export function formEnv(url: string, status: Status, top: FormTop, message: string, uc?: Uc, extra: { flags?: Flag[]; retry_after_seconds?: number; problems?: number } = {}): Envelope {
  const e = env(url, status, { message, uc, flags: extra.flags, retry_after_seconds: extra.retry_after_seconds });
  e.form = top;
  if (extra.problems !== undefined && e.counts) e.counts.problems = extra.problems;
  return e;
}

// The page, fetched fresh, and the one form asked for (hidden values included, in memory only).
export async function loadForm(url: string, index: number, jar?: CookieJar): Promise<Loaded | Envelope> {
  const u = parseSafeUrl(url);
  const pageUrl = u.href.split("#")[0];
  throwIfCancelled();
  // Like read with fresh: every rule applies (robots.txt, waits, Safe Browsing, signing, walls). The
  // only cookies a submit will ever send are the ones the site sets here, during this fetch.
  const res = await politeFetch(pageUrl, jar ? { onHeaders: (h) => jar.collect(h.url, h.headers) } : {});
  if (jar) jar.frozen = true;
  throwIfCancelled();
  const early = earlyOutcome(url, res);
  if (early) return early;
  if (res.read !== "html") // W-20: a file is never read here either (it was not read past its first bytes)
    return formEnv(url, "error", { index, reason: "not_html" }, NOT_HTML, { final_url: res.url });
  const r = await runUntrusted<{ forms: FullForm[]; omitted: number; flags: Flag[]; wall: WallInfo | null }>({ op: "forms", body: res.body, url: res.url }, res.body.length);
  throwIfCancelled();
  noteGetActions(r.forms);
  if (r.wall) return wallEnv(url, r.wall, res.url, { final_url: res.url });
  const form = r.forms.find((f) => f.index === index);
  if (!form) return formEnv(url, "error", { index, reason: "no_such_form" }, NO_SUCH_FORM, { final_url: res.url, forms: r.forms.length + r.omitted });
  return { pageUrl, finalUrl: res.url, form, flags: r.flags };
}

// Shared by preview and submit: the form must be allowed and the values must fit. Returns the request
// or the refusal to send back.
export function checkForm(url: string, index: number, l: Loaded, values: unknown): Built | Envelope {
  const pub = publicForm(l.form);
  const base: Uc = { final_url: l.finalUrl, form: pub };
  if (l.form.not_allowed)
    return formEnv(url, "refused", { index, reason: "not_allowed", not_allowed: l.form.not_allowed }, NOT_ALLOWED_TEXT[l.form.not_allowed] + " Nothing was sent.", base, { flags: l.flags });
  const b = buildRequest(l.form, l.pageUrl, values);
  if ("problems" in b) return formEnv(url, "refused", { index, reason: "invalid_values" }, PROBLEM_TEXT, { ...base, problems: b.problems }, { flags: l.flags, problems: b.problems.length });
  if ("tooMany" in b) return formEnv(url, "refused", { index, reason: "too_large" }, TOO_MANY_VALUES, base, { flags: l.flags });
  if ("tooLarge" in b) return formEnv(url, "refused", { index, reason: "too_large" }, TOO_LARGE_REQUEST, base, { flags: l.flags });
  if ("payment" in b || requestHasCard(b.built.method, b.built.url, b.built.body))
    return formEnv(url, "refused", { index, reason: "not_allowed", not_allowed: "payment" }, PAYMENT_VALUE, base, { flags: l.flags });
  return b.built;
}
export const isBuilt = (x: Built | Envelope): x is Built => "preview_hash" in x;
export const goodIndex = (i: unknown): i is number => Number.isSafeInteger(i) && (i as number) >= 1 && (i as number) <= MAX_FORMS;

export async function formPreview(url: string, index: number, values?: unknown, ctx: Ctx = DEFAULT): Promise<Envelope> {
  if (!goodIndex(index)) return stampProfile(env(url, "error", { message: BAD_INDEX }));
  return guarded(
    "form_preview", url, { ...ctx, allow_flagged: false }, undefined,
    async () => {
      const l = await loadForm(url, index);
      if (!isLoaded(l)) return l;
      const b = checkForm(url, index, l, values);
      if (!isBuilt(b)) return b;
      // Whether a slip covers the request's TARGET right now. Reads only: nothing is claimed.
      const c = slips.checkSlip("submit_form", b.url);
      const slip: FormTop["slip"] = "refused" in c ? { covered: false, refused: c.refused } : { covered: true, id: c.slip_id, uses_left: c.uses_left, expires_at: c.expires_at };
      return formEnv(
        url, "ok", { index, method: b.method, preview_hash: b.preview_hash, slip },
        PREVIEW_OK + (slip.covered ? PREVIEW_SLIP : PREVIEW_NO_SLIP),
        { final_url: l.finalUrl, form: publicForm(l.form), request: b.preview },
        { flags: l.flags },
      );
    },
    {}, undefined, true, false,
  );
}

// What came back after the request went out. The form WAS sent in every case here.
// v0.9 (Travis, item B): the answer repeated a secret the site set for this form. Fixed codes only: the HTTP
// status and the size; nothing from the answer (body, headers, URL) is shown, recorded or cached.
export const WITHHELD = (status: number, size: number) =>
  `${SENT} The site answered HTTP ${status} (${size} bytes), but its answer repeated a secret value the site set for this form (a hidden value or a cookie), so Tiresias withheld the whole answer: nothing from it is shown or recorded. Read the page again with read if you need to see where you are.`;
export function withheldEnv(url: string, top: FormTop, status: number, size: number): Envelope {
  const e = formEnv(url, "ok", { ...top, reason: "secret_withheld", http_status: status }, WITHHELD(status, size));
  e.untrusted_content = null;
  if (e.counts) e.counts.receipts = 0;
  return e;
}
const answerSize = (res: RawResponse) => res.size ?? res.raw?.length ?? res.bytes?.length ?? res.file?.size ?? Buffer.byteLength(res.body ?? "");

async function answerHoldsSecret(texts: string[], secrets: Secrets): Promise<boolean> {
  if (noSecrets(secrets)) return false;
  try {
    return await runUntrusted<boolean>({ op: "echo", texts, secrets }, texts.reduce((n, t) => n + t.length, 0));
  } catch {
    throwIfCancelled();
    return true; // an answer that cannot be checked is withheld
  }
}

export async function afterSubmit(url: string, top: FormTop, res: RawResponse, secrets: Secrets, meta: CallMeta, agent: string): Promise<Envelope> {
  // One check of the raw answer, before anything is parsed, recorded or shown: in the worker, under the parse time
  // budget. A check that cannot finish (too slow, too big, cancelled) withholds the answer: it fails closed.
  if (!noSecrets(secrets)) {
    const texts = rawTexts({ headers: res.headers, url: res.url, body: res.body, bytes: res.bytes, fileBody: res.file?.body, declared: [res.file?.declared_type, res.file?.declared_name] });
    if (await answerHoldsSecret(texts, secrets)) return withheldEnv(url, top, res.status, answerSize(res));
  }
  const uc: Uc = { final_url: res.url };
  const w = detectWall({ status: res.status, headers: res.headers });
  if (w) {
    const e = wallEnv(url, w, res.url, uc);
    e.message = `${SENT} The answer is a wall (HTTP ${res.status}): a person has to take it from here.`;
    e.form = top;
    return e;
  }
  if (res.status === 402) {
    const e = env(url, "payment_required", { message: `${SENT} The site answered that it wants payment. Tiresias read the price and did not pay.`, uc: { ...uc, price: parsePrice(res.headers, res.body) } });
    e.form = top;
    return e;
  }
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    return formEnv(url, "error", { ...top, reason: "redirect_not_followed" },
      `${SENT} The site answered with a redirect (HTTP ${res.status}). Tiresias follows no redirect after a submit, so nothing more was requested. The address it named is in untrusted_content.location; read it with read if you need it.`,
      { ...uc, ...(loc && loc.length <= 4096 ? { location: loc } : {}) });
  }
  if (res.status === 429 || res.status === 503) {
    const ra = res.headers.get("retry-after");
    return formEnv(url, "error", { ...top, reason: "http_error" }, `${SENT} The site asked Tiresias to slow down (HTTP ${res.status}).`, { ...uc, retry_after: ra?.slice(0, 200) }, { retry_after_seconds: cooldownSeconds(res.status, ra) });
  }
  if (res.status < 200 || res.status > 299) return formEnv(url, "error", { ...top, reason: "http_error" }, `${SENT} The site answered HTTP ${res.status}.`, uc);
  // W-20: the answer is a file. It is flagged like any file (and checked by the owner's scanner), never read.
  if (res.file) {
    // The declared type and name were in the raw check above; what is inside (Office text, zip names) is checked
    // by fileWarning before anything from it is recorded.
    const f: FileFacts = { ...res.file };
    let e: Envelope;
    try {
      e = await fileWarning(url, res.url, f, meta, agent, undefined, {}, secrets);
    } catch (err) {
      if (err instanceof SecretWithheld) return withheldEnv(url, top, res.status, answerSize(res));
      throw err;
    }
    e.message = `${SENT} The site accepted it (HTTP ${res.status}) and answered with a file. ${e.message}`;
    e.form = top;
    return e;
  }
  const k = res.body || res.bytes?.length ? res.read : undefined;
  if (!k) return formEnv(url, "ok", top, `${SENT} The site accepted it (HTTP ${res.status}). Its answer was empty.`, uc);
  // The answer is read like a page (outline with receipts), in the worker, and never cached.
  let page: Awaited<ReturnType<typeof parsePage>>;
  try {
    page = await parsePage(k, res.body, res.bytes, res.url, res.fileFlags, looksHtml(res.headers.get("content-type"), res.body), res.headers.get("content-language"), undefined, secrets);
  } catch (err) {
    if (err instanceof SecretWithheld) return withheldEnv(url, top, res.status, answerSize(res));
    throw err;
  }
  const { parsed, wall } = page;
  // Check the full extracted text, before previews can cut off a long secret or receipts can be recorded.
  // Joining blocks also covers a secret split by the reader's paragraph-size cap.
  if (!noSecrets(secrets) && await answerHoldsSecret([
    JSON.stringify(parsed), parsed.sections.flatMap((s) => s.blocks.map((b) => b.text)).join("\n"),
  ], secrets)) return withheldEnv(url, top, res.status, answerSize(res));
  noteGetActions(parsed.forms);
  if (wall) {
    const e = wallEnv(url, wall, res.url, uc);
    e.message = `${SENT} The page that came back shows a wall: a person has to take it from here.`;
    e.form = top;
    return e;
  }
  const now = new Date().toISOString();
  const entry: CacheEntry = {
    parser: PARSER_VERSION, url, source_url: res.url, final_url: res.url, door: "text", door_detail: detailOf(k),
    hash: "", content_type: res.headers.get("content-type") ?? "", fetched_at: now, checked_at: now, parsed,
  };
  const c = await buildContent(entry, {});
  // What was built from the answer (a PDF's text, decoded entities) is checked again before any receipt is recorded.
  if (valueHoldsSecret({ uc: c.uc, receipts: c.receipts, flags: parsed.flags }, secrets)) return withheldEnv(url, top, res.status, answerSize(res));
  recordReceipts(c.receipts);
  const e = env(url, "ok", { door: "text", door_detail: entry.door_detail, flags: parsed.flags, flags_dropped: parsed.flags_dropped, message: `${SENT} The site accepted it (HTTP ${res.status}); its answer is below.`, uc: c.uc, receipts: c.receipts });
  csvCount(e, parsed);
  stampLanguage(e, parsed.language); // W-26 (v0.7)
  e.form = top;
  return e;
}

export async function formSubmit(url: string, index: number, values: unknown, previewHash: unknown, ctx: Ctx = DEFAULT): Promise<Envelope> {
  if (ctx.private || sessionPrivate()) {
    const e = formEnv(url, "refused", { index, reason: "private_mode" }, PRIVATE_SUBMIT);
    e.private = true;
    return stampProfile(e);
  }
  if (!goodIndex(index)) return stampProfile(env(url, "error", { message: BAD_INDEX }));
  if (typeof previewHash !== "string" || !HASH_RE.test(previewHash)) return stampProfile(formEnv(url, "refused", { index, reason: "bad_preview_hash" }, BAD_HASH));
  // What happened after the slip was claimed, so the reply says it even when the call ends in an error.
  const st: { top?: FormTop; went?: boolean; secrets?: Secrets; status?: number; size?: number } = {};
  const out = await guarded(
    "form_submit", url, { ...ctx, allow_flagged: false }, undefined,
    async (meta) => {
      const jar = new CookieJar();
      const l = await loadForm(url, index, jar);
      if (!isLoaded(l)) return l;
      const b = checkForm(url, index, l, values);
      if (!isBuilt(b)) return b;
      if (b.preview_hash !== previewHash) return formEnv(url, "refused", { index, reason: "form_changed" }, FORM_CHANGED, { final_url: l.finalUrl, form: publicForm(l.form), request: b.preview });
      // The TARGET is checked before any slip is used: Safe Browsing (no allow_flagged for a submit),
      // the address checks, robots.txt, a Retry-After wait, a Crawl-delay Tiresias will not wait for.
      const target = new URL(b.url);
      // W-25 (v0.6, Codex round 6): the owner's site settings first, before any lookup (Safe Browsing, DNS)
      // learns the target.
      assertSiteAllowed(target);
      await currentGate()?.(target);
      await assertPublicUrl(target);
      // The same pre-send check politeFetch makes before every hop (v0.5.1: one copy, fetcher.ts).
      const rule = await policyCheck(target);
      if (!rule.ok && "wall" in rule) return wallEnv(url, rule.wall, rule.wallUrl);
      if (!rule.ok) {
        const why = rule.refused === COOLDOWN_TEXT ? "the site asked Tiresias to wait (Retry-After)." : rule.refused === CRAWL_DELAY_TEXT ? "the site asks for a Crawl-delay longer than Tiresias will wait." : rule.refused;
        return formEnv(url, "refused", { index, reason: "target_refused" }, TARGET_REFUSED + why, rule.retryAfter ? { retry_after: rule.retryAfter } : undefined, { retry_after_seconds: rule.retrySeconds });
      }
      throwIfCancelled();
      if (requestHasCard(b.method, b.url, b.body)) return formEnv(url, "refused", { index, reason: "not_allowed", not_allowed: "payment" }, PAYMENT_VALUE);
      // As late as possible: one use of the matching slip that expires soonest, or a refusal.
      const claim = slips.claimSlip("submit_form", target.href, "form_submit", { agent: ctx.agent });
      if ("refused" in claim) return formEnv(url, "refused", { index, reason: claim.refused === "private_mode" ? "private_mode" : "no_slip", slip: { covered: false, refused: claim.refused } }, claim.message + " Nothing was sent.");
      meta.slip = claim.slip_id;
      st.secrets = secretsOf([...b.hidden_values, ...jar.values()]); // the hidden values and this call's cookies (v0.9)
      const top: FormTop = { index, method: b.method, slip: { covered: true, id: claim.slip_id, use: claim.use }, sent: false };
      st.top = top;
      const counter = currentSent();
      const before = counter?.requests ?? 0;
      let res: RawResponse | undefined;
      try {
        res = await politeFetch(b.url, {
          method: b.method,
          body: b.body,
          submit: true,
          beforeSend: (u) => {
            if (!slips.claimedStillValid(claim, "submit_form", u.href)) {
              top.reason = "no_slip";
              throw new Refused("The claimed permission slip expired or was revoked before sending. Nothing was sent; the reserved use stays spent.");
            }
          },
          cookies: jar,
          files: fileOptions(), // W-20: an answer that is a file is fingerprinted and flagged
          // Honest about where the form came from: the page's origin and address, as a browser sends them.
          firstHeaders: { ...(b.content_type ? { "content-type": b.content_type, origin: new URL(l.finalUrl).origin } : {}), referer: l.finalUrl },
        });
      } finally {
        st.went = (counter?.requests ?? 0) > before;
        top.sent = st.went;
        if (res) {
          top.http_status = res.status;
          st.status = res.status;
          st.size = answerSize(res);
        }
        // The owner's audit trail of an action taken in their name: written whenever the request went out.
        if (st.went) {
          try {
            receipts.recordSent({ page_url: l.finalUrl, url: b.url, method: b.method, slip: claim.slip_id, use: claim.use, fields: b.sent_fields, hidden: b.hidden_names, outcome: res ? res.status : "no_answer", agent: ctx.agent });
          } catch (e) {
            console.error(`Could not write the record of the form sent: ${(e as Error).message}`);
          }
        }
      }
      return afterSubmit(url, top, res, st.secrets, meta, ctx.agent);
    },
    {}, undefined, true, true,
  );
  // An error after the slip was claimed (a wall on a redirect hop, a cancelled answer) still says
  // which use was spent and whether the request left.
  // v0.9 (item B): whatever came back after the request left (an answer, a Location, a final URL, an error
  // detail) is checked once more as a whole; one that holds a secret the site set is withheld, never masked.
  if (st.top && st.went && valueHoldsSecret({ uc: out.untrusted_content, form: out.form, message: out.message }, st.secrets)) {
    const w = withheldEnv(url, st.top, st.status ?? 0, st.size ?? 0);
    if (st.status === undefined) w.message = `${SENT} Then the call ended before a whole answer came back, and what Tiresias had of it repeated a secret value the site set for this form (a hidden value or a cookie), so it is withheld: nothing from it is shown or recorded.`;
    return stampProfile({ ...w, ...(out.private ? { private: out.private } : {}) });
  }
  if (st.top && !out.form) {
    out.form = st.top;
    if (st.went && out.message && !out.message.startsWith(SENT)) out.message = `${SENT} Then: ${out.message}`;
  }
  return out;
}

