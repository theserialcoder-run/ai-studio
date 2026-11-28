// Process-wide state that must survive `next dev` recompiles. A recompile re-runs a module and would
// otherwise reset it, so a still-running job looked "interrupted" and locks/queues were lost.
// In production each module runs once, so this behaves like a plain module-level value.

export function processState<T>(key: string, init: () => T): T {
  const g = globalThis as unknown as Record<string, unknown>;
  const k = `__wonderboy_${key}`;
  if (!(k in g)) g[k] = init();
  return g[k] as T;
}
