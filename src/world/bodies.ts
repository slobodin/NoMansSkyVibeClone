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
    grassLush: 0x3f7030,
    grassDry: 0x857f4c,
    forest: 0x2b5427,
    rock: 0x6e6457,
    snow: 0xf2f6fa,
    snowLine: 550,
  },
  atmosphere: {
    height: 2400,
    // Earth's sea-level Rayleigh coefficients (5.8, 13.5, 33.1) x 1e-6 scaled by 20: Earth's scale
    // height is 8 km, ours 450 m, so this keeps a similar vertical optical depth (a blue sky).
    rayleighScattering: [1.16e-4, 2.7e-4, 6.62e-4],
    rayleighScaleHeight: 450,
    mieScattering: 1.2e-4,
    mieScaleHeight: 120,
    mieAnisotropy: 0.85,
    absorption: [5.2e-5, 1.52e-4, 6.8e-6],
  },
  ocean: {
    color: 0x0f5d7a,
    absorption: [0.3, 0.07, 0.045],
  },
};
