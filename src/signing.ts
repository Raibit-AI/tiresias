// SPDX-License-Identifier: Apache-2.0
// N-07: Web Bot Auth. Every request that leaves Tiresias is signed when a key exists AND
// `signature_agent` is set in config.json; otherwise nothing changes (unsigned, same honest
// user agent). If signing is set up but cannot be done, the call fails with a clear message:
// it never falls back to unsigned. Private mode signs too (it hides nothing from sites).
//
// Each request, and each redirect hop, is signed for its own authority: the signature covers
// "@authority" and "signature-agent", with created now, expires 60 seconds later, a fresh
// 64-byte nonce, keyid = the key's JWK thumbprint, alg ed25519 and tag "web-bot-auth".
import { generateNonce, sign, type WebBotSigner } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import { ConfigError, loadSigningConfig, type AgentStyle } from "./config.js";
import { SigningError } from "./errors.js";
import { inspectKey } from "./keys.js";

export const SIGNATURE_LIFETIME_MS = 60_000;

interface Active {
  signer: WebBotSigner;
  header: string; // the Signature-Agent value
}

// The signer is built from the key only when the key file changes, but the storage checks (folders,
// owner, mode, not a link) run on EVERY use, so a later chmod or a swapped folder is caught at once.
// The config is small and is read on every use too.
let memo: { stamp: string; signer: WebBotSigner } | null = null;

async function active(): Promise<Active | null> {
  const key = inspectKey(memo?.stamp); // throws SigningError for anything but a truly absent key
  if (!key) {
    memo = null;
    return null; // no key: signing is off
  }
  let cfg;
  try {
    cfg = loadSigningConfig();
  } catch (e) {
    if (e instanceof ConfigError) throw new SigningError(`Signing is set up but config.json is wrong: ${e.message}`);
    throw new SigningError(`Signing is set up but config.json cannot be read: ${(e as Error).message.replace(/[\r\n]/g, " ").slice(0, 120)}`);
  }
  if (!cfg) return null; // a key but no signature_agent: signing is off
  if (!key.jwk && memo?.stamp !== key.stamp) throw new SigningError("The signing key could not be loaded.");
  if (key.jwk) {
    try {
      memo = { stamp: key.stamp, signer: await signerFromJWK(key.jwk) };
    } catch {
      throw new SigningError("The signing key file is damaged (the key cannot be loaded). Fix it, or run `tiresias keys init --force` for a new key.");
    }
  }
  return { signer: memo!.signer, header: headerValue(cfg.signature_agent, cfg.style) };
}

export const headerValue = (url: string, style: AgentStyle) => (style === "dictionary" ? `sig1="${url}";type=directory` : `"${url}"`);

// Headers to add to one outgoing request, or null when signing is off.
export async function signingHeaders(u: URL): Promise<Record<string, string> | null> {
  const a = await active();
  if (!a) return null;
  const now = new Date();
  try {
    const f = await sign(new Request(u.href, { headers: { "Signature-Agent": a.header } }), {
      signer: a.signer,
      created: now,
      expires: new Date(now.getTime() + SIGNATURE_LIFETIME_MS),
      nonce: generateNonce(),
    });
    return { signature: f.signature, "signature-input": f.signatureInput, "signature-agent": a.header };
  } catch (e) {
    throw new SigningError(`Signing the request failed: ${(e as Error).message.replace(/[\r\n]/g, " ").slice(0, 160)}`);
  }
}
