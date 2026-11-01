// SPDX-License-Identifier: Apache-2.0
// W-05 (v0.5.1): a permission slip is a promise from a PERSON. `slip grant` and `slip revoke` go on only
// when standard input is a terminal and the person types the slip's site back. An agent running the CLI
// from a shell, with its input a pipe or a file, cannot answer the prompt. (A process that builds its own
// pseudo-terminal can; the spec says plainly that an agent with a shell is trusted like the owner for
// everything except granting, and the optional Touch ID step is what would close that gap.)
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { SlipError } from "./errors.js";

export const NOT_A_PERSON =
  "Granting or revoking a permission slip needs a person at a terminal: run the command yourself in a terminal window and type the site back when asked. An agent cannot grant or revoke a slip. Nothing was changed.";
export const NO_MATCH = "What was typed does not match, so nothing was changed.";
export const NO_ANSWER = "No answer was typed in time, so nothing was changed.";
const WAIT_MS = 120_000;

export interface PersonIO {
  input: Readable & { isTTY?: boolean };
  output: Writable;
}

// Ask the person to type `expected` back. Resolves when they did; throws a SlipError otherwise. The
// prompt goes to `output` (standard error by default, so standard output stays one JSON reply).
export async function confirmByTyping(expected: string, what: string, io: PersonIO = { input: process.stdin, output: process.stderr }): Promise<void> {
  if (io.input.isTTY !== true) throw new SlipError(NOT_A_PERSON);
  const rl = readline.createInterface({ input: io.input, output: io.output, terminal: false });
  try {
    const answer = await new Promise<string | null>((resolve) => {
      const t = setTimeout(() => resolve(null), WAIT_MS);
      rl.once("line", (l) => (clearTimeout(t), resolve(l)));
      rl.once("close", () => (clearTimeout(t), resolve(null)));
      io.output.write(`${what}\nTo confirm, type ${expected} and press Return: `);
    });
    if (answer === null) throw new SlipError(NO_ANSWER);
    if (answer.trim() !== expected) throw new SlipError(NO_MATCH);
  } finally {
    rl.close();
  }
}
