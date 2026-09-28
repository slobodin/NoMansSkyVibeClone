import * as THREE from 'three';
import type { PlanetConfig } from '../planet/PlanetConfig';

/**
 * The ocean, rendered in the composite pass rather than as a mesh.
 *
 * The sea surface is a perfect sphere (radius = sea level), so for every pixel we can intersect
 * the view ray with it analytically and compare with the depth buffer: if the water comes first,
 * we shade water. That gives a pixel-exact shoreline at any distance, and - because the depth
 * buffer still holds the seabed - we know how much water the light crosses: shallow water over
 * sand looks turquoise, deep water deep blue, just as in reality, where red light is absorbed
 * within a few metres and blue travels furthest.
 *
 * The water colour is refraction (the seabed, dimmed by absorption, plus light scattered back
 * by the water itself) mixed with reflection (the sky, reusing the atmosphere code), weighted by
 * the Fresnel term: little reflection looking straight down, a mirror at grazing angles.
 * Requires ATMOSPHERE_GLSL and VALUE_NOISE_GLSL to be included first.
 */
export const OCEAN_GLSL = /* glsl */ `
  uniform float uOceanRadius;    // sea-level radius, 0 = no ocean
  uniform vec3 uWaterColor;      // how much light deep water scatters back (an albedo)
  uniform vec3 uWaterAbsorption; // 1/m per RGB channel: red fades first
  uniform mat3 uWorldToPlanet;   // world directions -> planet-local (waves stick to the planet)
  uniform float uTime;           // seconds, animates the waves

  vec3 noiseGradient(vec3 p) {
    const float e = 0.05;
    float n = valueNoise(p);
    return vec3(valueNoise(p + vec3(e, 0.0, 0.0)) - n, valueNoise(p + vec3(0.0, e, 0.0)) - n,
                valueNoise(p + vec3(0.0, 0.0, e)) - n) / e;
  }

  // Normal of the wavy surface at p: two octaves of drifting noise, used as a height field.
  // Waves fade out with distance, where they would only shimmer.
  vec3 waveNormal(vec3 p, vec3 up, float distance) {
    float fade = 1.0 - smoothstep(100.0, 1500.0, distance);
    if (fade <= 0.0) return up;
    vec3 local = uWorldToPlanet * (p - uPlanetCenter);
    // gradient of height = amplitude * frequency * gradient of noise (chain rule)
    vec3 slope = 0.35 * 0.2 * noiseGradient(local * 0.2 + vec3(uTime * 0.25, 0.0, uTime * 0.15));
    slope += 0.08 * 0.8 * noiseGradient(local * 0.8 + vec3(-uTime * 0.4, uTime * 0.3, 0.0));
    slope = transpose(uWorldToPlanet) * slope; // back to world axes
    slope -= up * dot(slope, up);              // only the horizontal part tilts the normal
    return normalize(up - slope * fade);
  }

  // The sky as seen from p looking along dir (for reflections): atmosphere scattering only.
  vec3 skyColor(vec3 p, vec3 dir) {
    float exit = raySphere(p, dir, uPlanetCenter, uAtmosphereRadius).y;
    vec3 transmit;
    return exit > 0.0 ? scatterAlongRay(p, dir, 0.0, exit, 8, transmit) : vec3(0.0);
  }

  // Light arriving at the water: direct sun on a horizontal surface plus a skylight estimate.
  vec3 lightOnWater(vec3 p, vec3 up) {
    vec3 zenithScatter = 1.0 - exp(-(uRayleighScattering * uRayleighScaleHeight + uMieScattering * uMieScaleHeight));
    float daylight = smoothstep(-0.25, 0.3, dot(up, uSunDirection));
    return sunlightAt(p) * max(dot(up, uSunDirection), 0.0) + uSunIntensity * zenithScatter * 0.6 * daylight;
  }

  // Colour of the sea surface hit at distance tSurface, with the scene (the seabed) seen through
  // it at sceneDistance with colour sceneColor.
  vec3 shadeOcean(vec3 dir, float tSurface, float sceneDistance, vec3 sceneColor) {
    vec3 p = dir * tSurface;
    vec3 up = normalize(p - uPlanetCenter);
    vec3 normal = waveNormal(p, up, tSurface);
    vec3 light = lightOnWater(p, up);

    // Refraction: the seabed, dimmed by the water in between, plus light the water scatters back.
    float waterPath = sceneDistance - tSurface;
    vec3 throughWater = exp(-uWaterAbsorption * waterPath);
    vec3 waterGlow = uWaterColor / PI * light;
    vec3 refracted = sceneColor * throughWater + waterGlow * (1.0 - throughWater);

    // Reflection of the sky, and the sharp glint of the sun.
    vec3 r = reflect(dir, normal);
    r = normalize(r + up * max(0.0, 0.03 - dot(r, up))); // waves never reflect the seabed
    vec3 reflection = skyColor(p, r) + sunlightAt(p) * pow(max(dot(r, uSunDirection), 0.0), 500.0) * 3.0;

    // Fresnel (Schlick's approximation): 2% reflection head-on, 100% at grazing angles.
    float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(-dir, normal), 0.0), 5.0);
    vec3 color = mix(refracted, reflection, fresnel);

    // Foam where the water is only a few decimetres deep: a broken white line along beaches.
    float depthBelow = waterPath * max(dot(-dir, up), 0.05);
    vec3 local = uWorldToPlanet * (p - uPlanetCenter);
    float foam = (1.0 - smoothstep(0.0, 0.5, depthBelow)) * smoothstep(0.4, 0.7, valueNoise(local * 1.3 + uTime * 0.3));
    return mix(color, light * 0.8 / PI, foam * 0.85);
  }

  // Looking around with the camera under water: everything fades into the water colour.
  vec3 shadeUnderwater(vec3 dir, float surfaceDistance, float sceneDistance, vec3 sceneColor) {
    vec3 up = normalize(-uPlanetCenter);
    vec3 light = lightOnWater(vec3(0.0), up);
    vec3 behind = sceneColor;
    float waterPath = sceneDistance;
    if (surfaceDistance < sceneDistance) {
      // Looking up through the surface: a bright, blurry view of the sky.
      behind = skyColor(dir * surfaceDistance, dir);
      waterPath = surfaceDistance;
    }
    vec3 throughWater = exp(-uWaterAbsorption * waterPath * 1.3);
    return behind * throughWater + uWaterColor / PI * light * (1.0 - throughWater);
  }
`;

export type OceanUniforms = ReturnType<typeof createOceanUniforms>;

export function createOceanUniforms(config: PlanetConfig) {
  const ocean = config.ocean;
  return {
    uOceanRadius: { value: ocean ? config.radius : 0 },
    uWaterColor: { value: new THREE.Color().setHex(ocean?.color ?? 0x000000) },
    uWaterAbsorption: { value: new THREE.Vector3(...(ocean?.absorption ?? [1, 1, 1])) },
    uWorldToPlanet: { value: new THREE.Matrix3() },
    uTime: { value: 0 },
  };
}
