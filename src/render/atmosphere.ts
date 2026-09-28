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
 * The GLSL below is shared by the full-screen pass (sky and aerial perspective, see
 * RenderPipeline.ts) and the terrain shader (sunlight reaching the ground), so the ground and
 * the sky always agree on the colour of the light. All positions are in world space, which the
 * floating origin makes camera-relative: the camera is at (0, 0, 0).
 */

export const ATMOSPHERE_GLSL = /* glsl */ `
  #ifndef PI
  #define PI 3.141592653589793
  #endif

  uniform vec3 uPlanetCenter;       // world space
  uniform float uPlanetRadius;      // sea level
  uniform float uAtmosphereRadius;  // top of the atmosphere
  uniform vec3 uRayleighScattering; // 1/m, RGB
  uniform float uRayleighScaleHeight;
  uniform float uMieScattering;     // 1/m
  uniform float uMieScaleHeight;
  uniform float uMieAnisotropy;
  uniform vec3 uAbsorption;         // 1/m, RGB: ozone-like absorption
  uniform vec3 uSunDirection;       // unit vector towards the sun
  uniform vec3 uSunIntensity;       // sunlight above the atmosphere

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

  // Density relative to sea level: x = Rayleigh, y = Mie.
  vec2 atmosphereDensity(vec3 p) {
    float altitude = max(length(p - uPlanetCenter) - uPlanetRadius, 0.0);
    return exp(-altitude / vec2(uRayleighScaleHeight, uMieScaleHeight));
  }

  // exp(-optical depth): the fraction of light that makes it through. Mie also absorbs a
  // little, hence extinction = 1.1 x scattering. uAbsorption is an ozone-like gas that absorbs
  // (without scattering) mostly green: it deepens the blue of the sky and, at sunset, removes the
  // green that Rayleigh scattering would otherwise add back - sunsets come out orange-red
  // instead of yellow. (Real ozone sits in a layer; here it simply follows the air density.)
  vec3 transmittance(vec2 opticalDepth) {
    return exp(-((uRayleighScattering + uAbsorption) * opticalDepth.x + uMieScattering * 1.1 * opticalDepth.y));
  }

  // Integral of the density from p towards the sun, up to the top of the atmosphere.
  vec2 opticalDepthToSun(vec3 p) {
    const int STEPS = 6;
    float rayLength = raySphere(p, uSunDirection, uPlanetCenter, uAtmosphereRadius).y;
    float ds = rayLength / float(STEPS);
    vec2 depth = vec2(0.0);
    for (int i = 0; i < STEPS; i++) {
      depth += atmosphereDensity(p + uSunDirection * (float(i) + 0.5) * ds);
    }
    return depth * ds;
  }

  // How much of the sun p can see past the planet: 1 = all, 0 = none (night).
  // From height r above the centre, the planet's edge (the horizon) lies acos(R / r) below the
  // horizontal. The sun is visible while its elevation is above that, and we fade over a few
  // degrees around it: a hard on/off test would draw razor-sharp shadow edges in the sky, while
  // real ones are softened by the sun's size and by light scattering more than once.
  float sunVisibility(vec3 p) {
    vec3 toP = p - uPlanetCenter;
    float r = length(toP);
    float sunElevation = asin(clamp(dot(toP, uSunDirection) / r, -1.0, 1.0));
    float horizonDip = acos(clamp(uPlanetRadius / r, 0.0, 1.0));
    return smoothstep(-horizonDip - 0.035, -horizonDip + 0.035, sunElevation);
  }

  // Sunlight arriving at p, after its trip through the atmosphere.
  vec3 sunlightAt(vec3 p) {
    float visibility = sunVisibility(p);
    if (visibility <= 0.0) return vec3(0.0);
    return uSunIntensity * transmittance(opticalDepthToSun(p)) * visibility;
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
  vec3 scatterAlongRay(vec3 origin, vec3 dir, float tStart, float tEnd, int steps, out vec3 transmit) {
    float ds = (tEnd - tStart) / float(steps);
    vec2 viewDepth = vec2(0.0);
    vec3 rayleigh = vec3(0.0);
    vec3 mie = vec3(0.0);
    for (int i = 0; i < 32; i++) {
      if (i >= steps) break;
      vec3 p = origin + dir * (tStart + (float(i) + 0.5) * ds);
      vec2 density = atmosphereDensity(p) * ds;
      viewDepth += density;
      float visibility = sunVisibility(p);
      if (visibility <= 0.0) continue;
      vec3 t = transmittance(viewDepth + opticalDepthToSun(p)) * visibility;
      rayleigh += density.x * t;
      mie += density.y * t;
    }
    transmit = transmittance(viewDepth);
    float cosAngle = dot(dir, uSunDirection);
    return uSunIntensity * (
      rayleigh * uRayleighScattering * rayleighPhase(cosAngle) +
      mie * uMieScattering * miePhase(cosAngle, uMieAnisotropy));
  }
`;

/** The uniforms ATMOSPHERE_GLSL declares, as one object that several materials can share. */
export type AtmosphereUniforms = ReturnType<typeof createAtmosphereUniforms>;

export function createAtmosphereUniforms(config: PlanetConfig, sunIntensity: THREE.Vector3) {
  const a = config.atmosphere;
  return {
    uPlanetCenter: { value: new THREE.Vector3() },
    uPlanetRadius: { value: config.radius },
    uAtmosphereRadius: { value: config.radius + a.height },
    uRayleighScattering: { value: new THREE.Vector3(...a.rayleighScattering) },
    uRayleighScaleHeight: { value: a.rayleighScaleHeight },
    uMieScattering: { value: a.mieScattering },
    uMieScaleHeight: { value: a.mieScaleHeight },
    uMieAnisotropy: { value: a.mieAnisotropy },
    uAbsorption: { value: new THREE.Vector3(...a.absorption) },
    uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
    uSunIntensity: { value: sunIntensity },
  };
}
