import type { PlanetConfig } from '../planet/PlanetConfig';

/**
 * The bodies of the star system. Each one is a seed plus a handful of parameters, so adding a
 * world is adding an entry here. (M1-M2 only have Verdant; the rest arrive in M3/M5.)
 */

/** The starting planet: green hills, oceans, a few mountain ranges with snowy peaks. */
export const VERDANT: PlanetConfig = {
  name: 'Verdant',
  seed: 20260928,
  radius: 10_000,
  rotationPeriod: 15 * 60, // a 15 minute day
  axialTilt: (18 * Math.PI) / 180,
  gravity: 9.81,
  terrain: {
    warpScale: 5000,
    warpAmount: 2500,
    continentScale: 7000,
    continentBias: 0.04,
    landHeight: 300,
    oceanDepth: 900,
    hillScale: 1100,
    hillHeight: 80,
    mountainScale: 4200,
    mountainHeight: 700,
    mountainMaskScale: 6000,
    detailScale: 70,
    detailHeight: 4,
  },
  colors: {
    seabedShallow: 0xc9b98a,
    seabedDeep: 0x3a5550,
    beach: 0xe0d09a,
    grassLush: 0x427f2e,
    grassDry: 0x8f9a52,
    forest: 0x2b5427,
    rock: 0x6e6457,
    snow: 0xf2f6fa,
    snowLine: 550,
  },
};
