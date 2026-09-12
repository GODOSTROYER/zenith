/** Single-writer process gate. It does not claim a distributed database lock. */
import { AsyncLocalStorage } from 'node:async_hooks';
interface Gate { held: AsyncLocalStorage<{active:boolean}>; tail: Promise<void>; queued: number }
const global = globalThis as typeof globalThis & { __zenithMutationGate?: Gate };
const gate = global.__zenithMutationGate ??= { held: new AsyncLocalStorage<{active:boolean}>(), tail: Promise.resolve(), queued: 0 };
export async function withMutationGate<T>(work: () => Promise<T>): Promise<T> {
  if (gate.held.getStore()?.active) return work();
  if (gate.queued >= 100) throw new Error('Mutation queue full; retry after existing operations finish.');
  gate.queued++;
  const previous = gate.tail; let release!: () => void;
  gate.tail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  const owner={active:true};
  try { return await gate.held.run(owner, work); }
  finally { owner.active=false; gate.queued--; release(); }
}
