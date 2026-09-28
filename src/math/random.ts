/**
 * Seeded pseudo-random numbers. Procedural content must be reproducible from a seed, so we never
 * use Math.random() for anything that ends up in the world.
 */

/** mulberry32: tiny, fast 32-bit PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal (mean 0, deviation 1) sample via the Box-Muller transform. */
export function gaussian(rand: () => number): number {
  const u = 1 - rand(); // (0, 1] so log() stays finite
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
