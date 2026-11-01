// SPDX-License-Identifier: Apache-2.0
// A Map that keeps at most `max` entries, dropping the least recently used (v0.5.1, N-06: the per-host
// maps of a long-running MCP server must not grow forever). `get` and `set` both count as a use.
export class LruMap<K, V> extends Map<K, V> {
  constructor(public readonly max: number) {
    super();
  }
  override get(k: K): V | undefined {
    if (!super.has(k)) return undefined;
    const v = super.get(k) as V;
    super.delete(k);
    super.set(k, v);
    return v;
  }
  override set(k: K, v: V): this {
    if (super.has(k)) super.delete(k);
    super.set(k, v);
    while (this.size > this.max) super.delete(this.keys().next().value as K);
    return this;
  }
}
export const MAX_HOSTS = 1000;
