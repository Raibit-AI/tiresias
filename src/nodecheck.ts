// SPDX-License-Identifier: Apache-2.0
// v0.9 rehearsal: on a Node older than the one Tiresias needs, say so plainly and stop, instead of failing later
// with an error about some missing feature. Imported first by cli.ts, so it runs before any other module's code.
export const MIN_NODE = [22, 13] as const;
export function oldNode(version: string): boolean {
  const [maj, min] = version.split(".").map(Number);
  return maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1]);
}
if (oldNode(process.versions.node)) {
  process.stderr.write(`Tiresias needs Node ${MIN_NODE.join(".")} or newer; this is Node ${process.versions.node}. Install a current Node from https://nodejs.org (or with your version manager) and run it again.\n`);
  process.exit(1);
}
