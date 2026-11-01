// SPDX-License-Identifier: Apache-2.0
// Bound htmlparser2's own open-element stack, not just the subsequent DOM walks. Its HTML and foreign
// context stacks shift on each open/close, making very deep tables and SVG super-linear.
import { DomHandler, Parser } from "htmlparser2";

export const MAX_DOM_DEPTH = 256;
type Attrs = Record<string, string>;

export function parseDocument(body: string) {
  const handler = new DomHandler();
  const opens: { start: number; end: number; attrs: Attrs }[] = [];
  // The bounded parser can forget an ancestor before its source end tag. Keep source scopes with
  // push/pop (not htmlparser2's shifting stacks), so flattening cannot turn hidden descendants into
  // shown siblings. Each attribute set refers to its original parent; the reader resolves these in
  // source order, once the page's style sheet is known, without copying attributes or walking chains.
  const inherited: [Attrs, Attrs][] = [];
  const scopes: { name: string; attrs: Attrs; previous?: number }[] = [];
  const byName = new Map<string, number>();
  const popScope = () => {
    const s = scopes.pop()!;
    if (s.previous === undefined) byName.delete(s.name);
    else byName.set(s.name, s.previous);
  };
  let bounds = { start: 0, end: 0 };
  let flattened = false;
  let forcedClose = false;
  let sourceClose = false;
  const open = handler.onopentag.bind(handler);
  const close = handler.onclosetag.bind(handler);
  const text = handler.ontext.bind(handler);
  handler.onopentag = (name, attrs) => {
    if (scopes.length) inherited.push([attrs, scopes[scopes.length - 1].attrs]);
    const key = name.toLowerCase();
    const previous = byName.get(key);
    byName.set(key, scopes.length);
    scopes.push({ name: key, attrs, previous });
    opens.push({ ...bounds, attrs });
    open(name, attrs);
  };
  handler.onclosetag = () => {
    const top = opens.pop();
    // An ordinary implied/void close still ends its source scope. If flattening has already
    // displaced intervening scopes, keep them until a source end tag rather than lose hiding.
    if (!forcedClose && !sourceClose && top && top.attrs === scopes[scopes.length - 1]?.attrs) popScope();
    close();
  };
  handler.ontext = (data) => {
    const scope = scopes[scopes.length - 1];
    if (!scope || scope.attrs === opens[opens.length - 1]?.attrs) return text(data);
    // Text after a flattened child's close (including raw text) has no element to inherit on.
    const attrs = {};
    inherited.push([attrs, scope.attrs]);
    open("thidden", attrs);
    text(data);
    close();
  };
  class BoundedParser extends Parser {
    override onopentagname(start: number, end: number): void {
      if (opens.length >= MAX_DOM_DEPTH) {
        // Close the deepest retained element before opening its next child: subsequent content is
        // flattened into siblings, never dropped. We parse one complete string, so these source offsets
        // stay in the parser's buffer. Use its own close path to keep foreign contexts and the DOM in sync.
        const top = opens[opens.length - 1];
        const at = this.startIndex;
        forcedClose = true;
        super.onclosetag(top.start, top.end);
        forcedClose = false;
        this.startIndex = at;
        flattened = true;
      }
      bounds = { start, end };
      super.onopentagname(start, end);
    }
    override onclosetag(start: number, end: number): void {
      const target = byName.get(body.slice(start, end).toLowerCase());
      if (target !== undefined) while (scopes.length > target) popScope();
      const left = scopes.length;
      sourceClose = true;
      super.onclosetag(start, end);
      sourceClose = false;
      // htmlparser2 can synthesize an element for an unmatched </p> or </br>.
      while (scopes.length > left) popScope();
    }
  }
  new BoundedParser(handler).end(body);
  return { doc: handler.root, flattened, inherited };
}
