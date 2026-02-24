export function createDeterministicRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function randomInt(
  random: () => number,
  minInclusive: number,
  maxInclusive: number,
): number {
  const span = maxInclusive - minInclusive + 1;
  return minInclusive + Math.floor(random() * span);
}

export function randomChance(random: () => number, probability: number): boolean {
  return random() < probability;
}
