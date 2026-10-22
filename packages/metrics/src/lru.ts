/** Minimal Map-based LRU cache. */
export class LruCache<K, V> {
  private map = new Map<K, V>();
  constructor(readonly max: number) {}
  get size() {
    return this.map.size;
  }
  has(key: K): boolean {
    return this.map.has(key);
  }
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined && !this.map.has(key)) return undefined;
    this.map.delete(key);
    this.map.set(key, v as V);
    return v;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as K);
    this.map.set(key, value);
  }
  clear() {
    this.map.clear();
  }
}
