# NMS Clone

A small, educational No Man's Sky–style game in the browser: three.js + TypeScript + Vite, fully
procedural, no art assets. See [PLAN.md](PLAN.md) for the goals and milestones, and
[docs/progress](docs/progress/README.md) for the screenshot history.

**Status:** M0–M4 done: a whole star system (a star, four planets and three moons on rails) and
a ship. Walk to it, take off from Verdant, fly through the air and out into space, pulse-drive to
the moon Lull, land, get out and walk, with no loading screens. Paused here so the result can be
played before M5 (distinct worlds).

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

On foot (the default; your ship is parked a few steps ahead):

| Key | Action |
|---|---|
| Mouse | look |
| W A S D | walk |
| Shift | sprint |
| Space | jump; hold in the air for the jetpack (3 s tank, refills on the ground); swim up |
| C | dive (in water) |
| E | board the ship (within 7 m of it) |

In the ship:

| Key | Action |
|---|---|
| Space | take off (when landed) |
| Mouse | pitch and yaw |
| A / D | roll (in the air, the wings level themselves when you let go) |
| W / S | throttle up / brake down to a hover; with neither, the speed is held (cruise control) |
| Shift | boost (with W) |
| J | pulse drive on / off: in space only, crosses between planets in seconds |
| E | land (below 300 m; not on water or slopes over 30°) / get out (when landed) |
| C | chase camera ↔ cockpit |

Speeds: 160 m/s in the air (boost 400), 1 km/s in space (boost 2.5 km/s), up to 30 km/s in pulse.

Anywhere:

| Key | Action |
|---|---|
| V | free-fly debug camera on/off (on: from wherever you are; off: drops you on foot onto the body below, not possible in open space; the ship stays where it was) |
| 1 – 7 | free-fly camera to a body (see the table above) |
| 0 | respawn on foot on Verdant, with the ship parked next to you |
| 9 | free-fly camera to the M0 test beacon |
| T | time speed ×1 / ×10 / ×60 / ×300 (orbits and days speed up) |
| F2 | screenshot to `screenshots/` (dev build only) |
| F3 | debug panel |
| F4 | terrain debug view: normal → LOD colours → LOD colours + wireframe |
| H | help |

The free-fly camera moves with W A S D, Space / C (up / down), Q / E (roll), Shift (×5) and the
mouse wheel (speed ×2 / ×0.5); its speed scales with the distance to the nearest surface.

### Things to try

1. **The M4 trip.** Walk to the ship, E, Space. Pull up and boost (Shift + W) out of the blue;
   when the panel says SPACE, press J. Find Lull's marker (it may be below the horizon - fly
   round Verdant, the pulse drive drops out if you dip into the air) and pulse towards it: it
   slows down by itself and drops out 3 km above Lull. Brake, dive, E below 300 m, E again to
   get out, and jump around in the low gravity with Verdant hanging in the black sky.
2. Fly low along the coast near the spawn, try the cockpit view (C).
3. Walk down to the bay and into the water; swim out, dive with C, look up from below.
4. Jetpack up a hillside (Space in the air) and look back at the lagoon.
5. Press T a few times and watch the sun set; at ×300, watch the moons circle their planets.
6. F3 shows the reference frame you are in (`frame`): watch it switch as you fly out.
7. F4 shows how the terrain's quadtree LOD follows you.

## Code tour

Read in this order:

1. `src/main.ts` — entry point.
2. `src/Game.ts` — owns everything and runs the frame loop:
   time → orbits & spins → active controller (on foot / ship / free camera) → world update →
   place camera → render.
3. `src/core/Universe.ts` — **camera-relative rendering**: the camera stays at the scene origin
   while the universe moves around it, so float32 precision is never a problem.
4. `src/core/ReferenceFrame.ts` — poses *and velocities* relative to a moving, rotating frame;
   every body is one.
5. The star system, in `src/world/`:
   - `bodies.ts` — the whole system as config: star, planets, moons.
   - `orbit.ts` — circular orbits "on rails": position (and its derivative, velocity) is a pure
     function of time.
   - `SolarSystem.ts` — builds the bodies, moves them each frame (parents before moons),
     answers "whose sphere of influence am I in?" and picks the frame to fly in (`frameAt`):
     the body's rotating frame near it, its non-rotating orbit frame further out, the star's
     frame in open space.
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
   - `Planet.ts` — ties it together: orbit, spin, frames, velocities, conversions.
7. On foot, in `src/controls/`:
   - `PlayerController.ts` — walking on a sphere: up = away from the centre, fixed-step
     physics, analytic collision, jetpack, swimming. Works on any body.
   - `FreeFlyController.ts` — the debug camera; keeps its pose in a reference frame.
   - `leveling.ts` — the "level the horizon" roll, shared by the free camera and the ship.
8. The ship, in `src/ship/`:
   - `shipModel.ts` — the model from primitives (lathe fuselage, extruded wings...), tripod
     landing gear, engine glow and flames.
   - `Ship.ts` — state machine (landed → takeoff → flying → landing), the arcade flight model
     (air vs space handling, pulse drive), frame switches that keep momentum, the tripod
     resting pose, collision.
   - `ShipCamera.ts` — chase camera on a smoothed "spring arm", and the cockpit.
9. Rendering, in `src/render/`:
   - `RenderPipeline.ts` — scene → HDR target → composite pass → FXAA.
   - `atmosphere.ts` — Rayleigh/Mie single scattering (sky, aerial perspective, sunsets), as
     functions of an `Atmosphere` struct: the composite pass draws every body's air, the terrain
     shader uses its own body's to light the ground, and CPU twins of the same functions light
     the ship (three.js DirectionalLight + HemisphereLight).
   - `ocean.ts` — the sea as an analytic sphere in the composite pass: depth-based colour,
     reflections, waves, foam, underwater.
   - `Starfield.ts`, `noiseGlsl.ts`.
10. HUD, in `src/ui/` (plain HTML over the canvas): `Markers.ts` (names and distances over
    bodies and the ship), `DebugHud.ts`, `hud.css`; input in `src/core/Input.ts`.
11. `src/dev/DevTools.ts` + `vite.config.ts` — `window.nms` console helpers: `step`, `settle`,
    `play` (drive frames by hand, even in a hidden tab) and `screenshot` (the progress history).

### Conventions

- 1 unit = 1 metre, time in seconds.
- Universe positions are float64 (plain JS numbers in `THREE.Vector3`); the GPU only ever sees
  camera-relative values. Terrain vertices are stored relative to their chunk's centre.
- The star is at the universe origin; everything else moves on rails as a function of game time.
- Frame velocities are per *real* second (they include the time speed-up), because the player's
  and the ship's physics integrate in real time.
- Logarithmic depth buffer, so a 0.1 m near plane and a 10⁹ m far plane coexist.
  Custom shaders include three's `logdepthbuf_*` chunks so they write the same depth values.
- Procedural content is a pure function of (seed, position): no `Math.random()` in world code.
- Lighting is linear HDR everywhere; exposure, tone mapping and sRGB happen once, at the end.
- Ship space and camera space: +Y up, looking down −Z.

## Known limitations (as of M4)

- The flight model is arcade: no gravity on the ship and no crash damage. Fly into the ground
  and you slide along it; after the pulse drive drops out you still cruise at 1 km/s until you
  brake.
- Landing refuses water and steep slopes rather than finding a better spot nearby.
- With time sped up, planets move at tens of km/s; on a frame switch the ship's speed is
  capped (7.5 km/s, 30 km/s in pulse) instead of inheriting it all. The free-fly debug camera
  still ignores frame velocities altogether.
- The ship casts no shadow, and nothing collides with it (you can walk through it).
- Only one body can have an ocean (Verdant's); atmospheres work for any number of bodies.
- No shadows between bodies (no eclipses) and no terrain shadows: a mountain in front of the
  setting sun still shows the sun's glow on its face.
- The ocean fills everything below sea level, including inland dips (small "puddles").
- Terrain LOD has no geomorphing: at speed you can notice chunks switching detail.
- Performance hasn't been tuned yet (by design). On an RTX 4060 a frame is ~2 ms, with an
  occasional hitch when many chunks stream in; the weak-GPU target from PLAN.md is untested.
