import * as THREE from 'three';
import type { PlanetConfig } from '../planet/PlanetConfig';

/**
 * Atmospheric scattering - the maths behind the blue sky, red sunsets, the haze that fades
 * distant mountains, and the glowing rim of a planet seen from space.
 *
 * MODEL: single scattering (Nishita et al. 1993, the approach of GPU Gems 2 ch. 16 and Sebastian
 * Lague's "Coding Adventure: Atmosphere"). Air contains two kinds of scatterers whose density
 * falls off exponentially with altitude:
 *   - Rayleigh: molecules. Scatter short wavelengths much more (hence blue sky, red sunsets),
 *     nearly evenly in all directions.
 *   - Mie: haze and dust. Grey, and mostly *forwards* (hence the bright glow around the sun).
 *
 * For a pixel we march along the view ray through the atmosphere. At each sample point P:
 *   sunlight reaching P  = sun * T(P -> sun)          (T = transmittance = exp(-optical depth))
 *   light sent towards us = that * density(P) * scattering coefficient * phase(angle)
 *   what reaches the eye  = that * T(camera -> P)
 * Summing gives the in-scattered light. The scene behind (terrain, stars) is dimmed by the
 * total transmittance along the ray. Samples in the planet's shadow receive no sunlight: that is
 * night, and the dark band that sweeps up the sky at dusk.
 *
 * Every function takes an `Atmosphere` struct describing one planet's air, because the
 * full-screen pass (RenderPipeline.ts) draws the atmospheres of all visible planets, while the
 * terrain shader uses its own planet's to light the ground - so ground and sky always agree on
 * the colour of the light. A planet without air has radius == planetRadius and zero coefficients.
 * All positions are in world space, which the floating origin makes camera-relative: the camera
 * is at (0, 0, 0).
 */

export const ATMOSPHERE_GLSL = /* glsl */ `
  #ifndef PI
  #define PI 3.141592653589793
  #endif

  struct Atmosphere {
    vec3 center;          // planet centre, world space
    float planetRadius;   // sea level
    float radius;         // top of the atmosphere (== planetRadius: no air)
    vec3 rayleigh;        // Rayleigh scattering at sea level, 1/m per RGB channel
    float rayleighHeight; // scale height: density falls by e every this many metres
    float mie;            // Mie scattering at sea level, 1/m
    float mieHeight;
    float mieG;           // Mie anisotropy
    vec3 absorption;      // ozone-like absorption at sea level, 1/m per RGB channel
    vec3 sunDirection;    // unit vector from this planet towards the sun
    vec3 sunIntensity;    // sunlight above the atmosphere
  };

  // Where a ray (origin + t * dir, dir normalised) enters and leaves a sphere: (tNear, tFar).
  // A miss returns tNear > tFar. Written to avoid subtracting nearly equal large numbers,
  // which matters in float32 when the camera is a metre above a 10 km sphere.
  vec2 raySphere(vec3 origin, vec3 dir, vec3 center, float radius) {
    vec3 oc = origin - center;
    float b = dot(oc, dir);
    float dist = length(oc);
    float c = (dist - radius) * (dist + radius);
    float discriminant = b * b - c;
    if (discriminant < 0.0) return vec2(1e30, -1e30);
    float s = sqrt(discriminant);
    float q = b > 0.0 ? -b - s : -b + s; // the root with the larger magnitude...
    float t0 = c / q;                    // ...and the other one via Vieta: t0 * t1 = c
    return vec2(min(t0, q), max(t0, q));
  }

  bool hasAir(Atmosphere a) {
    return a.radius > a.planetRadius;
  }

  // Density relative to sea level: x = Rayleigh, y = Mie.
  vec2 atmosphereDensity(Atmosphere a, vec3 p) {
    float altitude = max(length(p - a.center) - a.planetRadius, 0.0);
    return exp(-altitude / vec2(a.rayleighHeight, a.mieHeight));
  }

  // exp(-optical depth): the fraction of light that makes it through. Mie also absorbs a
  // little, hence extinction = 1.1 x scattering. 'absorption' is an ozone-like gas that absorbs
  // (without scattering) mostly green: it deepens the blue of the sky and, at sunset, removes the
  // green that Rayleigh scattering would otherwise add back - sunsets come out orange-red
  // instead of yellow. (Real ozone sits in a layer; here it simply follows the air density.)
  vec3 transmittance(Atmosphere a, vec2 opticalDepth) {
    return exp(-((a.rayleigh + a.absorption) * opticalDepth.x + a.mie * 1.1 * opticalDepth.y));
  }

  // Integral of the density from p towards the sun, up to the top of the atmosphere.
  vec2 opticalDepthToSun(Atmosphere a, vec3 p) {
    const int STEPS = 6;
    float rayLength = max(raySphere(p, a.sunDirection, a.center, a.radius).y, 0.0);
    float ds = rayLength / float(STEPS);
    vec2 depth = vec2(0.0);
    for (int i = 0; i < STEPS; i++) {
      depth += atmosphereDensity(a, p + a.sunDirection * (float(i) + 0.5) * ds);
    }
    return depth * ds;
  }

  // How much of the sun p can see past the planet: 1 = all, 0 = none (night).
  // From height r above the centre, the planet's edge (the horizon) lies acos(R / r) below the
  // horizontal. The sun is visible while its elevation is above that, and we fade over a few
  // degrees around it: a hard on/off test would draw razor-sharp shadow edges in the sky, while
  // real ones are softened by the sun's size and by light scattering more than once.
  float sunVisibility(Atmosphere a, vec3 p) {
    vec3 toP = p - a.center;
    float r = length(toP);
    float sunElevation = asin(clamp(dot(toP, a.sunDirection) / r, -1.0, 1.0));
    float horizonDip = acos(clamp(a.planetRadius / r, 0.0, 1.0));
    return smoothstep(-horizonDip - 0.035, -horizonDip + 0.035, sunElevation);
  }

  // Sunlight arriving at p, after its trip through the atmosphere (if there is one).
  vec3 sunlightAt(Atmosphere a, vec3 p) {
    float visibility = sunVisibility(a, p);
    if (visibility <= 0.0) return vec3(0.0);
    vec3 sun = a.sunIntensity * visibility;
    return hasAir(a) ? sun * transmittance(a, opticalDepthToSun(a, p)) : sun;
  }

  // Skylight on a surface facing 'up': the sky glows and lights the ground from all around. A
  // cheap estimate: the fraction of sunlight the air column overhead scatters (more blue than
  // red), fading out after sunset. No air, no skylight - shadows on airless moons are black.
  vec3 skyIrradiance(Atmosphere a, vec3 up) {
    vec3 zenithScatter = 1.0 - exp(-(a.rayleigh * a.rayleighHeight + a.mie * a.mieHeight));
    float daylight = smoothstep(-0.25, 0.3, dot(up, a.sunDirection));
    return a.sunIntensity * zenithScatter * 0.6 * daylight;
  }

  float rayleighPhase(float cosAngle) {
    return 3.0 / (16.0 * PI) * (1.0 + cosAngle * cosAngle);
  }

  // Cornette-Shanks phase function, a common approximation for Mie scattering.
  float miePhase(float cosAngle, float g) {
    float g2 = g * g;
    return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + cosAngle * cosAngle))
      / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));
  }

  // Single scattering along origin + t * dir for t in [tStart, tEnd].
  // Returns the in-scattered light; 'transmit' receives the transmittance of the whole segment.
  vec3 scatterAlongRay(Atmosphere a, vec3 origin, vec3 dir, float tStart, float tEnd, int steps, out vec3 transmit) {
    float ds = (tEnd - tStart) / float(steps);
    vec2 viewDepth = vec2(0.0);
    vec3 rayleigh = vec3(0.0);
    vec3 mie = vec3(0.0);
    for (int i = 0; i < 32; i++) {
      if (i >= steps) break;
      vec3 p = origin + dir * (tStart + (float(i) + 0.5) * ds);
      vec2 density = atmosphereDensity(a, p) * ds;
      viewDepth += density;
      float visibility = sunVisibility(a, p);
      if (visibility <= 0.0) continue;
      vec3 t = transmittance(a, viewDepth + opticalDepthToSun(a, p)) * visibility;
      rayleigh += density.x * t;
      mie += density.y * t;
    }
    transmit = transmittance(a, viewDepth);
    float cosAngle = dot(dir, a.sunDirection);
    return a.sunIntensity * (
      rayleigh * a.rayleigh * rayleighPhase(cosAngle) +
      mie * a.mie * miePhase(cosAngle, a.mieG));
  }
`;

/**
 * JS mirror of the GLSL `Atmosphere` struct (same field names): three.js uploads a plain object
 * like this as a struct uniform. One per planet; the terrain material and the composite pass
 * reference the same object, so updating it once per frame updates both.
 */
export interface AtmosphereParams {
  center: THREE.Vector3;
  planetRadius: number;
  radius: number;
  rayleigh: THREE.Vector3;
  rayleighHeight: number;
  mie: number;
  mieHeight: number;
  mieG: number;
  absorption: THREE.Vector3;
  sunDirection: THREE.Vector3;
  sunIntensity: THREE.Vector3;
}

/** No air at all: for airless bodies and for unused slots of uniform arrays. */
export function emptyAtmosphereParams(): AtmosphereParams {
  return {
    center: new THREE.Vector3(),
    planetRadius: 0,
    radius: 0,
    rayleigh: new THREE.Vector3(),
    rayleighHeight: 1,
    mie: 0,
    mieHeight: 1,
    mieG: 0,
    absorption: new THREE.Vector3(),
    sunDirection: new THREE.Vector3(1, 0, 0),
    sunIntensity: new THREE.Vector3(),
  };
}

export function createAtmosphereParams(config: PlanetConfig, sunIntensity: THREE.Vector3): AtmosphereParams {
  const a = config.atmosphere;
  return {
    center: new THREE.Vector3(),
    planetRadius: config.radius,
    radius: config.radius + (a?.height ?? 0),
    rayleigh: new THREE.Vector3(...(a?.rayleighScattering ?? [0, 0, 0])),
    // Scale heights must not be 0 even without air: the density function divides by them.
    rayleighHeight: a?.rayleighScaleHeight ?? 1,
    mie: a?.mieScattering ?? 0,
    mieHeight: a?.mieScaleHeight ?? 1,
    mieG: a?.mieAnisotropy ?? 0,
    absorption: new THREE.Vector3(...(a?.absorption ?? [0, 0, 0])),
    sunDirection: new THREE.Vector3(1, 0, 0),
    sunIntensity,
  };
}

// --- CPU twins ------------------------------------------------------------------------------------
// The same light as the shaders compute, for things lit by three.js's built-in lights instead of
// our own shaders (the ship): a DirectionalLight carries `sunlightAt`, a HemisphereLight the
// `skyIrradiance`. Evaluated once per frame at the camera, so plain JS is fast enough.

const toPoint = new THREE.Vector3();
const sample = new THREE.Vector3();

/** CPU version of the GLSL sunVisibility: 0..1, how much of the sun is above p's horizon. */
export function sunVisibility(a: AtmosphereParams, p: THREE.Vector3): number {
  toPoint.copy(p).sub(a.center);
  const r = toPoint.length();
  const sunElevation = Math.asin(THREE.MathUtils.clamp(toPoint.dot(a.sunDirection) / r, -1, 1));
  const horizonDip = Math.acos(THREE.MathUtils.clamp(a.planetRadius / r, 0, 1));
  return THREE.MathUtils.smoothstep(sunElevation, -horizonDip - 0.035, -horizonDip + 0.035);
}

/** CPU version of the GLSL sunlightAt: sunlight reaching p, reddened by the air it crossed. */
export function sunlightAt(a: AtmosphereParams, p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.copy(a.sunIntensity).multiplyScalar(sunVisibility(a, p));
  if (a.radius <= a.planetRadius) return out; // no air
  // Optical depth towards the sun (opticalDepthToSun): 6 samples to the top of the atmosphere.
  const rayLength = Math.max(raySphereFar(p, a.sunDirection, a.center, a.radius), 0);
  const ds = rayLength / 6;
  let rayleighDepth = 0;
  let mieDepth = 0;
  for (let i = 0; i < 6; i++) {
    sample.copy(a.sunDirection).multiplyScalar((i + 0.5) * ds).add(p);
    const altitude = Math.max(sample.distanceTo(a.center) - a.planetRadius, 0);
    rayleighDepth += Math.exp(-altitude / a.rayleighHeight) * ds;
    mieDepth += Math.exp(-altitude / a.mieHeight) * ds;
  }
  return out.set(
    out.x * Math.exp(-((a.rayleigh.x + a.absorption.x) * rayleighDepth + a.mie * 1.1 * mieDepth)),
    out.y * Math.exp(-((a.rayleigh.y + a.absorption.y) * rayleighDepth + a.mie * 1.1 * mieDepth)),
    out.z * Math.exp(-((a.rayleigh.z + a.absorption.z) * rayleighDepth + a.mie * 1.1 * mieDepth)),
  );
}

/** CPU version of the GLSL skyIrradiance: light from the whole sky on a surface facing `up`. */
export function skyIrradiance(a: AtmosphereParams, up: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const daylight = THREE.MathUtils.smoothstep(up.dot(a.sunDirection), -0.25, 0.3);
  const scatter = (rayleigh: number) => 1 - Math.exp(-(rayleigh * a.rayleighHeight + a.mie * a.mieHeight));
  return out
    .set(scatter(a.rayleigh.x), scatter(a.rayleigh.y), scatter(a.rayleigh.z))
    .multiply(a.sunIntensity)
    .multiplyScalar(0.6 * daylight);
}

/** Far intersection of a ray with a sphere (the .y of the GLSL raySphere), or -1 on a miss. */
function raySphereFar(origin: THREE.Vector3, dir: THREE.Vector3, center: THREE.Vector3, radius: number): number {
  toPoint.copy(origin).sub(center);
  const b = toPoint.dot(dir);
  const c = toPoint.lengthSq() - radius * radius;
  const discriminant = b * b - c;
  return discriminant < 0 ? -1 : -b + Math.sqrt(discriminant);
}
