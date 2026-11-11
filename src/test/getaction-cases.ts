// SPDX-License-Identifier: Apache-2.0
// Routing equivalences shared by read guards and static and live renderer guards.
export const actionPairs: [string, string][] = [
  ["https://vote.example/vote", "https://vote.example/%252576ote"],
  ["https://vote.example/vote", "https://vote.example/a%2F..%2Fvote"],
  ["https://vote.example/vote", "https://vote.example/a\\..\\vote"],
  ["https://vote.example/vote", "https://vote.example/a%5C..%5Cvote"],
  ["https://vote.example/vote", "https://vote.example/vote;session=123"],
  ["https://vote.example/vote", "https://vote.example/VOTE"],
  ["https://vote.example/vote", "https://vote.example/ｖｏｔｅ"],
  ["https://vote.example/caf%C3%A9", "https://vote.example/cafe%CC%81"],
  ["http://vote.example/vote", "http://vote.example:80/vote"],
  ["https://vote.example/vote", "https://vote.example:443/vote"],
  ["https://vote.example:8443/vote", "https://vote.example:8443/%76ote"],
  ["https://vote.example/vote", "https://VOTE.example./vote"],
  ["https://[2001:db8::1]/vote", "https://[2001:0db8:0:0:0:0:0:1]/vote"],
  ["https://bücher.example/vote", "https://xn--bcher-kva.example/vote"],
  ["https://vote.example/vote", "https://vote.example/%EF%BC%8576ote"],
  ["https://vote.example/vote", "https://vote.example/a/.%09./vote"],
  ["https://vote.example/vote", "https://vote.example/a/%0A../vote"],
  ["https://vote.example/vote", "https://vote.example/a/..%0D/vote"],
  ["https://vote.example/vote", "https://vote.example/a/%2e%09%2e/vote"],
  ["https://vote.example/vote", "https://vote.example/%25%0976ote"],
  ["https://vote.example/vote", "https://vote.example/%%0976ote"],
  ["https://vote.example/vote", "https://vote.example/a/.%2509./vote"],
  ["https://vote.example/vote", "https://vote.example/%2525%250976ote"],
  ...["%09", "%0A", "%0D", "%0B", "%0C", "%20", "%7F", "%2509", "%250A", "%250D", "%250B", "%250C", "%2520",
    "\u200b", "\u00ad", "%E2%80%8B", "%C2%AD", "%C2%A0", "%E2%80%A8", "%E2%80%A9", "%E3%80%80",
    "-", "_", "!", "%2E", "%2B", "%27", "%22"]
    .map((inside): [string, string] => ["https://vote.example/vote", `https://vote.example/vo${inside}te`]),
  ["https://vote.example/a/b", "https://vote.example/a/---/b"],
  ["https://vote.example/가", "https://vote.example/ᄀ-ᅡ"],
  ["https://vote.example/café/12٣", "https://vote.example/CAFÉ/１２٣"],
];
export const differentActionPairs: [string, string][] = [
  ["https://vote.example/vote", "https://vote.example/voter"],
  ["https://vote.example/a/b", "https://vote.example/ab"],
  ["https://vote.example/vote", "https://vote.example/note"],
  ["https://vote.example/café", "https://vote.example/cafe"],
  ["https://vote.example/a/1", "https://vote.example/a/2"],
];
export const cappedTarget = "https://vote.example/%" + "25".repeat(100) + "76ote";
