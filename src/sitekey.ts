// SPDX-License-Identifier: Apache-2.0
// v0.6 (Codex round 1): one name per site. "example.com." and "example.com" are the same host (a trailing dot
// only says the name is complete), so site settings, the per-site queue, the spacing files and Retry-After
// waits all use the same written form: lower case (the URL parser already lowers and IDNA-encodes), no
// trailing dot. Without it, a trailing dot gave a site a second, independent clock.
export const hostKey = (hostname: string): string => {
  const h = hostname.toLowerCase();
  return h.endsWith(".") ? h.slice(0, -1) : h;
};
// An origin ("https://example.com.:8443") in the same form: scheme, host key, port.
export function canonOrigin(origin: string): string {
  try {
    const u = new URL(origin);
    if (u.origin === "null") return origin;
    return `${u.protocol}//${hostKey(u.hostname)}${u.port ? ":" + u.port : ""}`;
  } catch {
    return origin;
  }
}
