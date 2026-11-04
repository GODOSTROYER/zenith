/**
 * Test fixture: a provider index whose own registrar needs arguments the
 * generator has no stand-in for, next to an alias that is not the provider's own
 * registrar. Neither may be called; the first is reported as a problem.
 */
export function registerOciDrivers(options: { toolkit: unknown }): void {
  throw new Error(`fixture registrar must not be called (${typeof options})`);
}

export function registerOciOtherDrivers(): void {
  throw new Error("fixture alias must not be called");
}
