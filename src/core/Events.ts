type Handler = (payload: any) => void;

const handlers = new Map<string, Set<Handler>>();

/** Tiny global event bus. */
export const Events = {
  on(name: string, fn: Handler): () => void {
    let set = handlers.get(name);
    if (!set) handlers.set(name, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  },

  emit(name: string, payload?: unknown): void {
    handlers.get(name)?.forEach((fn) => fn(payload));
  },
};
