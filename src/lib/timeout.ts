/**
 * One deadline helper, for work that has no cancellation of its own.
 *
 * The underlying promise is abandoned rather than aborted: this is for callers
 * that would otherwise hang forever on a socket the library will not close, and
 * `message` is what the person reading the failure sees, so it names the setting
 * to fix rather than the timer that fired.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
