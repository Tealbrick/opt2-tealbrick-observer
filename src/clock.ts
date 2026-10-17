// Injected clock (CON-11): tests set it, so nothing waits on the wall clock.
let clock: () => number = Date.now;
export function setClock(fn: () => number): void {
  clock = fn;
}
export function now(): number {
  return clock();
}
