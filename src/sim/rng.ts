// src/sim/rng.ts
// Pseudo-Random Number Generator (PRNG) deterministik berbasis Mulberry32

export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(arr: T[]): T;
}

export function createRng(seed: number): Rng {
  let s = Math.floor(seed) >>> 0;

  function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function int(min: number, max: number): number {
    return Math.floor(next() * (max - min + 1)) + min;
  }

  function chance(p: number): boolean {
    return next() < p;
  }

  function pick<T>(arr: T[]): T {
    if (arr.length === 0) {
      throw new Error("Cannot pick from an empty array");
    }
    return arr[Math.floor(next() * arr.length)];
  }

  return { next, int, chance, pick };
}
