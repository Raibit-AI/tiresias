// SPDX-License-Identifier: Apache-2.0
// The embedding endpoint may receive page text without confirmation only on the owner's own network.
import net from "node:net";

export function isOwnerAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const bare = ip.split("%")[0];
  if (!net.isIPv6(bare)) return false;
  // URL canonicalization gives mapped addresses one spelling, including when their tail was dotted IPv4.
  const host = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(host);
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    return isOwnerAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(host.split(":")[0], 16);
  return host === "::1" || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}
