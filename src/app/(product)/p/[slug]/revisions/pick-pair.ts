/**
 * Ticking revisions to compare. Two at a time, and the third tick has to say
 * which one it pushed out — silently dropping a selection the operator made is
 * the screen changing its mind without telling anyone.
 */

export interface Picked {
  /** at most two ids, oldest tick first */
  ids: string[];
  /** the id the newest tick displaced, if any */
  released?: string;
}

export function pickPair(current: string[], id: string): Picked {
  if (current.includes(id)) return { ids: current.filter((x) => x !== id) };
  const ids = [...current, id].slice(-2);
  return { ids, released: current.find((x) => !ids.includes(x)) };
}
