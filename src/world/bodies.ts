import type { PlanetConfig } from '../planet/PlanetConfig';
import type { StarConfig } from './SolarSystem';

/**
 * The star system: one star, four planets, three moons (see PLAN.md). Each body is a seed plus
 * a handful of parameters, so adding a world is adding an entry here.
 *
 * Distances are compressed like No Man's Sky's: planets are 3-12 km in radius and the whole system
 * is under a thousand km across. Orbits are slow (hours) so the sky changes gently; moons are
 * tidally locked (their day equals their month), so they always show their planet the same face.
 *
 * For now bodies differ in size, shape parameters, colours and air. Their special features -
 * lava cracks, ice spires, craters, crystals, clouds, rings - come in M5.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const deg = (degrees: number) => (degrees * Math.PI) / 180;

export const SUN: StarConfig = {
  name: 'Sol',
  radius: 6000,
  color: [1.0, 0.93, 0.82],
};

/** Closest to the star: red rock and dunes under an orange sky. */
const EMBER: PlanetConfig = {
  name: 'Ember',
  seed: 7101,
  radius: 7000,
  rotationPeriod: 12 * MINUTE,
  axialTilt: deg(4),
  gravity: 8.5,
  orbit: { parent: 'Sol', radius: 90_000, period: 1.5 * HOUR, phase: 0.8, inclination: deg(2) },
  soiRadius: 30_000,
  terrain: {
    warpScale: 3500,
    warpAmount: 1500,
    continentScale: 5000,
    continentBias: 0.2,
    landHeight: 200,
    oceanDepth: 300,
    hillScale: 700,
    hillHeight: 90,
    mountainScale: 2500,
    mountainHeight: 500,
    mountainMaskScale: 4000,
    detailScale: 50,
    detailHeight: 4,
  },
  colors: {
    seabedShallow: 0x4a2a22, // dark basalt lowlands
    seabedDeep: 0x2a1612,
    beach: 0x7a3418,
    grassLush: 0xa4401e, // red dunes
    grassDry: 0xc0662e, // orange sand
    forest: 0x6e2414,
    rock: 0x4a3230,
    snow: 0xe8b070, // pale salt flats instead of snow
    snowLine: 5000,
  },
  atmosphere: {
    height: 1800,
    // Stylised: red scatters most here, so the sky is orange (and sunsets turn bluish).
    rayleighScattering: [2.4e-4, 1.1e-4, 4e-5],
    rayleighScaleHeight: 400,
    mieScattering: 1.5e-4, // dusty
    mieScaleHeight: 200,
    mieAnisotropy: 0.7,
    absorption: [0, 2e-5, 6e-5],
  },
};

/** The starting planet: green hills, oceans, a few mountain ranges with snowy peaks. */
const VERDANT: PlanetConfig = {
  name: 'Verdant',
  seed: 20260928,
  radius: 10_000,
  rotationPeriod: 15 * MINUTE,
  axialTilt: deg(18),
  gravity: 9.81,
  orbit: { parent: 'Sol', radius: 180_000, period: 2 * HOUR, phase: 2.64, inclination: 0 },
  soiRadius: 55_000,
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

/** Verdant's moon: grey and airless - black sky at noon - with low gravity. */
const LULL: PlanetConfig = {
  name: 'Lull',
  seed: 4242,
  radius: 3500,
  rotationPeriod: 25 * MINUTE, // = orbital period: tidally locked
  axialTilt: 0,
  gravity: 1.6,
  orbit: { parent: 'Verdant', radius: 32_000, period: 25 * MINUTE, phase: 1.0, inclination: deg(5) },
  soiRadius: 12_000,
  terrain: {
    warpScale: 2500,
    warpAmount: 800,
    continentScale: 3000,
    continentBias: 0.1,
    landHeight: 120,
    oceanDepth: 250,
    hillScale: 600,
    hillHeight: 60,
    mountainScale: 1500,
    mountainHeight: 250,
    mountainMaskScale: 2500,
    detailScale: 40,
    detailHeight: 3,
  },
  colors: {
    seabedShallow: 0x3a3a3e, // dark "maria"
    seabedDeep: 0x2c2c30,
    beach: 0x585858,
    grassLush: 0x6e6e6c,
    grassDry: 0x7c7a76,
    forest: 0x5e5e60,
    rock: 0x4a4948,
    snow: 0x9a9a9a,
    snowLine: 5000,
  },
};

/** Cold: pale ice plains and blue-grey rock under a whitish sky. */
const RIME: PlanetConfig = {
  name: 'Rime',
  seed: 91919,
  radius: 9000,
  rotationPeriod: 20 * MINUTE,
  axialTilt: deg(25),
  gravity: 9,
  orbit: { parent: 'Sol', radius: 290_000, period: 3 * HOUR, phase: 4.0, inclination: deg(1.5) },
  soiRadius: 55_000,
  terrain: {
    warpScale: 4000,
    warpAmount: 2000,
    continentScale: 6000,
    continentBias: 0.1,
    landHeight: 150,
    oceanDepth: 400,
    hillScale: 900,
    hillHeight: 60,
    mountainScale: 1800,
    mountainHeight: 600,
    mountainMaskScale: 5000,
    detailScale: 60,
    detailHeight: 3,
  },
  colors: {
    seabedShallow: 0xa8cde0, // frozen seas
    seabedDeep: 0x7fa9c4,
    beach: 0xdbe9f1,
    grassLush: 0xe4eff5,
    grassDry: 0xc5dbe6,
    forest: 0xa4c3d6,
    rock: 0x55677a,
    snow: 0xffffff,
    snowLine: 120,
  },
  atmosphere: {
    height: 2200,
    rayleighScattering: [7e-5, 1.6e-4, 3.6e-4],
    rayleighScaleHeight: 450,
    mieScattering: 3.5e-4, // icy haze
    mieScaleHeight: 250,
    mieAnisotropy: 0.75,
    absorption: [1e-5, 3e-5, 0],
  },
};

/** Rime's moon: yellow sulfur ground in a toxic green haze. */
const SULFA: PlanetConfig = {
  name: 'Sulfa',
  seed: 3131,
  radius: 4000,
  rotationPeriod: 30 * MINUTE, // tidally locked
  axialTilt: 0,
  gravity: 3.5,
  orbit: { parent: 'Rime', radius: 30_000, period: 30 * MINUTE, phase: 2.5, inclination: deg(4) },
  soiRadius: 12_000,
  terrain: {
    warpScale: 2000,
    warpAmount: 800,
    continentScale: 3000,
    continentBias: 0.05,
    landHeight: 150,
    oceanDepth: 250,
    hillScale: 500,
    hillHeight: 70,
    mountainScale: 1200,
    mountainHeight: 300,
    mountainMaskScale: 2500,
    detailScale: 40,
    detailHeight: 3,
  },
  colors: {
    seabedShallow: 0x7c7a1e,
    seabedDeep: 0x4a4c10,
    beach: 0xd6c65a,
    grassLush: 0xd8c03c,
    grassDry: 0xefe07a,
    forest: 0xa89024,
    rock: 0x6a5626,
    snow: 0xfff6b0,
    snowLine: 400,
  },
  atmosphere: {
    height: 1500,
    rayleighScattering: [1.0e-4, 3.6e-4, 1.2e-4], // green scatters most
    rayleighScaleHeight: 350,
    mieScattering: 5e-4,
    mieScaleHeight: 200,
    mieAnisotropy: 0.7,
    absorption: [8e-5, 0, 1.5e-4],
  },
};

/** The outer giant: purple lowlands and violet skies (its rings and glowing crystals come in M5). */
const NYX: PlanetConfig = {
  name: 'Nyx',
  seed: 777,
  radius: 12_000,
  rotationPeriod: 18 * MINUTE,
  axialTilt: deg(12),
  gravity: 11,
  orbit: { parent: 'Sol', radius: 420_000, period: 4 * HOUR, phase: 5.5, inclination: deg(3) },
  soiRadius: 70_000,
  terrain: {
    warpScale: 5000,
    warpAmount: 2500,
    continentScale: 8000,
    continentBias: 0.08,
    landHeight: 250,
    oceanDepth: 700,
    hillScale: 1200,
    hillHeight: 100,
    mountainScale: 3000,
    mountainHeight: 700,
    mountainMaskScale: 6500,
    detailScale: 70,
    detailHeight: 4,
  },
  colors: {
    seabedShallow: 0x3a2a55,
    seabedDeep: 0x1e1432,
    beach: 0xb8a6d0,
    grassLush: 0x5c2f80,
    grassDry: 0x8a5aa8,
    forest: 0x3b1c5e,
    rock: 0x3c3448,
    snow: 0xe8dcff,
    snowLine: 550,
  },
  atmosphere: {
    height: 2600,
    rayleighScattering: [2.6e-4, 1.1e-4, 5.2e-4], // red + blue: violet
    rayleighScaleHeight: 480,
    mieScattering: 1.5e-4,
    mieScaleHeight: 150,
    mieAnisotropy: 0.8,
    absorption: [0, 1.2e-4, 0],
  },
};

/** Nyx's tiny, jagged moon: airless, with steep lilac peaks. */
const SHARD: PlanetConfig = {
  name: 'Shard',
  seed: 2468,
  radius: 2500,
  rotationPeriod: 35 * MINUTE, // tidally locked
  axialTilt: 0,
  gravity: 1.2,
  orbit: { parent: 'Nyx', radius: 40_000, period: 35 * MINUTE, phase: 0.3, inclination: deg(6) },
  soiRadius: 10_000,
  terrain: {
    warpScale: 1200,
    warpAmount: 500,
    continentScale: 1800,
    continentBias: 0.1,
    landHeight: 100,
    oceanDepth: 150,
    hillScale: 400,
    hillHeight: 60,
    mountainScale: 700,
    mountainHeight: 450,
    mountainMaskScale: 1500,
    detailScale: 30,
    detailHeight: 3,
  },
  colors: {
    seabedShallow: 0x3a3058,
    seabedDeep: 0x221c34,
    beach: 0x9890b8,
    grassLush: 0x6f629a,
    grassDry: 0x8a7fb0,
    forest: 0x574a80,
    rock: 0x221e2e,
    snow: 0xb8d0e0,
    snowLine: 200,
  },
};

/** In orbit order, each planet followed by its moons (a parent must come before its moons). */
export const BODIES: readonly PlanetConfig[] = [EMBER, VERDANT, LULL, RIME, SULFA, NYX, SHARD];

/** Where the game starts. */
export const HOME = 'Verdant';
