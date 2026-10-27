// Load-robust performance guards (L39). What they protect is the SHAPE of the cost (no super-linear blow-up, no ReDoS), not a
// wall-clock number: this Mac often runs at load 20+, and a 20 ms median then fails for nothing. So a guard times the SAME work at
// two sizes, interleaved run by run (both sizes see the same load), and checks the ratio of the medians: linear ≈ 4 for 4× the
// input, quadratic ≈ 16; the limit is 8. A generous absolute ceiling catches a blow-up that is slow at both sizes. Work too fast
// to measure (the big median under FLOOR_MS) passes the ratio check: timer noise would dominate it, and a real blow-up is far
// above it. A failed ratio is measured again (up to 3 times): load can spoil one measurement, a quadratic cost fails every one.
export const RATIO_LIMIT = 8;
export const FLOOR_MS = 2;

export interface Scaling {
  small: number;
  big: number;
  ratio: number;
  ok: boolean;
  why: string;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

function once(f: (input: string) => unknown, small: string, big: string, runs: number): { small: number; big: number } {
  const s: number[] = [];
  const b: number[] = [];
  f(small); // warm up
  f(big);
  for (let i = 0; i < runs; i++) {
    let t = performance.now();
    f(small);
    s.push(performance.now() - t);
    t = performance.now();
    f(big);
    b.push(performance.now() - t);
  }
  return { small: median(s), big: median(b) };
}

/** Time `f` on `small` and `big` (big = 4× small); ok when the ratio stays under RATIO_LIMIT and the big median under `ceilingMs`. */
export function scaling(f: (input: string) => unknown, small: string, big: string, opts: { runs?: number; ceilingMs: number; attempts?: number; ratioLimit?: number }): Scaling {
  const limit = opts.ratioLimit ?? RATIO_LIMIT;
  const attempts = opts.attempts ?? 3;
  let last: Scaling = { small: 0, big: 0, ratio: 0, ok: false, why: "not measured" };
  for (let a = 0; a < attempts; a++) {
    const m = once(f, small, big, opts.runs ?? 9);
    const ratio = m.big / Math.max(m.small, 0.001);
    const fast = m.big < FLOOR_MS;
    const ok = m.big < opts.ceilingMs && (fast || ratio < limit);
    last = { ...m, ratio, ok, why: `small ${m.small.toFixed(2)} ms, big ${m.big.toFixed(2)} ms, ratio ${ratio.toFixed(1)} (limit ${limit}), ceiling ${opts.ceilingMs} ms` };
    if (ok) return last;
    if (m.big >= opts.ceilingMs * 4) return last; // far over the ceiling: no point in measuring again
  }
  return last;
}

/** A deliberately quadratic "detector": the fire-on-bad stub of the guards. */
export function quadraticStub(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) for (let j = i; j < text.length; j += 1) n += text.charCodeAt(j) & 1;
  return n;
}
