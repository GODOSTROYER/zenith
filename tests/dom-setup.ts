// Node 26 can disable jsdom's native localStorage unless a
// --localstorage-file is supplied. Component tests need deterministic storage,
// not a host-persistent file, so provide the Web Storage contract in that case.
if (!globalThis.localStorage) {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? values.get(key)! : null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
  } satisfies Pick<Storage, "length" | "clear" | "getItem" | "key" | "removeItem" | "setItem">;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}
