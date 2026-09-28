# NMS Clone

A small, educational No Man's Sky–style game in the browser: three.js + TypeScript + Vite, fully
procedural, no art assets. See [PLAN.md](PLAN.md) for the goals and milestones, and
[docs/progress](docs/progress/README.md) for the screenshot history.

**Status:** M0–M3 done: a whole star system — a star, four planets and three moons on rails —
that you can fly around (debug camera) and walk on, with atmospheres, an ocean and day/night.
Paused here so the result can be played before M4 (the ship).

## Running

```bash
npm install
npm run dev
```

Open http://localhost:5173 and click into the game to capture the mouse (Esc releases it).
`npm run typecheck` type-checks everything; `npm run build` makes a production build in `dist/`.

## The system

| Key | Body | Orbits | Radius | Notes |
|---|---|---|---|---|
| 1 | Ember | Sol, 90 km | 7 km | red dunes, orange sky |
| 2 | **Verdant** (start) | Sol, 180 km | 10 km | green hills, oceans, blue sky |
| 3 | Lull | Verdant, 32 km | 3.5 km | grey, airless, low gravity |
| 4 | Rime | Sol, 290 km | 9 km | ice plains, pale sky |
| 5 | Sulfa | Rime, 30 km | 4 km | sulfur ground, toxic green haze |
| 6 | Nyx | Sol, 420 km | 12 km | purple lowlands, violet sky |
| 7 | Shard | Nyx, 40 km | 2.5 km | tiny, jagged, airless |

Planets take 1.5–4 hours to go round the star and moons 25–35 minutes round their planet (moons
are tidally locked). The bodies differ only in shape, colours and air for now; their special
features (lava, ice spires, craters, crystals, clouds, rings) are M5.

## Controls

On foot (the default):

| Key | Action |
|---|---|
| Mouse | look |
| W A S D | walk |
| Shift | sprint |
| Space | jump; hold in the air for the jetpack (3 s tank, refills on the ground); swim up |
| C | dive (in water) |

Free-fly camera (a debug camera until the ship arrives in M4):

| Key | Action |
|---|---|
| V | toggle walking ↔ free-fly (keeps the view; toggling back drops you onto the body you are near — not possible in open space) |
| W A S D, Space / C | move, up / down; speed scales with the distance to the nearest surface |
| Q / E | roll |
| Shift | boost ×5 |
| Mouse wheel | speed ×2 / ×0.5 |

Anywhere:

| Key | Action |
|---|---|
| 1 – 7 | free-fly to a body (see the table above) |
| 0 | respawn on foot on Verdant |
| 9 | free-fly to the M0 test beacon |
| T | time speed ×1 / ×10 / ×60 / ×300 (orbits and days speed up) |
| F2 | screenshot to `screenshots/` (dev build only) |
| F3 | debug panel |
| F4 | terrain debug view: normal → LOD colours → LOD colours + wireframe |
| H | help |

### Things to try

1. Walk down to the bay and into the water; swim out, dive with C, look up from below.
2. Jetpack up a hillside (Space in the air) and look back at the lagoon.
3. Press 3 to fly to Lull, get close to the ground and press V: walk in low gravity with Verdant
   hanging in the black sky.
4. Press T a few times and watch the sun set; at ×300, watch the moons circle their planets.
5. Fly from one body to another with the free camera (watch the debug panel's `frame` line
   switch as you cross spheres of influence).
6. F4 shows how the terrain's quadtree LOD follows you.

## Code tour

Read in this order:

1. `src/main.ts` — entry point.
2. `src/Game.ts` — owns everything and runs the frame loop:
   time → orbits & spins → active controller → world update → place camera → render.
3. `src/core/Universe.ts` — **camera-relative rendering**: the camera stays at the scene origin
   while the universe moves around it, so float32 precision is never a problem.
4. `src/core/ReferenceFrame.ts` — poses relative to a moving/rotating frame; every body is one.
5. The star system, in `src/world/`:
   - `bodies.ts` — the whole system as config: star, planets, moons.
   - `orbit.ts` — circular orbits "on rails": position is a pure function of time.
   - `SolarSystem.ts` — builds the bodies, moves them each frame (parents before moons) and
     answers "whose sphere of influence am I in?". `Game.freeFlyFrame` then picks the camera's
     frame: the body's rotating frame near it, its non-rotating orbit frame further out, the
     star's frame in open space.
   - `Star.ts` — the sun.
6. A body, in `src/planet/`:
   - `PlanetConfig.ts` — a planet or moon is plain data: seed + parameters.
   - `TerrainGenerator.ts` (+ `src/math/noise.ts`) — the height function, a pure function of
     direction, shared by the Web Workers (meshes) and the main thread (collision).
   - `cubeSphere.ts` — cube-face coordinates ↔ directions on the sphere.
   - `TerrainNode.ts` + `Terrain.ts` — quadtree LOD: split/merge by distance; a parent stays
     visible until all four children are ready, so there are never holes. This is also the
     *distant-body LOD*: far away, a body collapses to its 6 root chunks (~12k triangles).
   - `chunkBuilder.ts`, `chunk.worker.ts`, `ChunkWorkerPool.ts` — chunk meshes (grid + normals
     + skirts) built in Web Workers, nearest first, for all bodies from one shared pool.
   - `terrainMaterial.ts` — per-pixel biome colours, detail noise, sun + sky lighting.
   - `Planet.ts` — ties it together: orbit, spin, frames, conversions.
7. `src/controls/PlayerController.ts` — walking on a sphere: up = away from the centre,
   fixed-step physics, analytic collision, jetpack, swimming. Works on any body.
   `src/controls/FreeFlyController.ts` — the debug camera; keeps its pose in a reference frame.
8. Rendering, in `src/render/`:
   - `RenderPipeline.ts` — scene → HDR target → composite pass → FXAA.
   - `atmosphere.ts` — Rayleigh/Mie single scattering (sky, aerial perspective, sunsets), as
     functions of an `Atmosphere` struct: the composite pass draws every body's air, the terrain
     shader uses its own body's to light the ground.
   - `ocean.ts` — the sea as an analytic sphere in the composite pass: depth-based colour,
     reflections, waves, foam, underwater.
   - `Starfield.ts`, `noiseGlsl.ts`.
9. `src/core/Input.ts`, `src/ui/DebugHud.ts`, `src/ui/hud.css` — input and HUD.
10. `src/dev/DevTools.ts` + `vite.config.ts` — `window.nms` console helpers: `step`, `settle`,
    `play` (drive frames by hand, even in a hidden tab) and `screenshot` (the progress history).

### Conventions

- 1 unit = 1 metre, time in seconds.
- Universe positions are float64 (plain JS numbers in `THREE.Vector3`); the GPU only ever sees
  camera-relative values. Terrain vertices are stored relative to their chunk's centre.
- The star is at the universe origin; everything else moves on rails as a function of game time.
- Logarithmic depth buffer, so a 0.1 m near plane and a 10⁹ m far plane coexist.
  Custom shaders include three's `logdepthbuf_*` chunks so they write the same depth values.
- Procedural content is a pure function of (seed, position): no `Math.random()` in world code.
- Lighting is linear HDR everywhere; exposure, tone mapping and sRGB happen once, at the end.

## Known limitations (as of M3)

- Switching reference frames converts positions and orientations but not *velocities* (a
  frame's own motion is ignored). Fine for the debug camera; the ship (M4) will need it.
- Only one body can have an ocean (Verdant's); atmospheres work for any number of bodies.
- No shadows between bodies (no eclipses) and no terrain shadows: a mountain in front of the
  setting sun still shows the sun's glow on its face.
- The ocean fills everything below sea level, including inland dips (small "puddles").
- Terrain LOD has no geomorphing: at speed you can notice chunks switching detail.
- Performance hasn't been tuned yet (by design). On an RTX 4060 a frame is ~2 ms, with an
  occasional hitch when many chunks stream in; the weak-GPU target from PLAN.md is untested.
