# NMS Clone

A small, educational No Man's Sky–style game in the browser: three.js + TypeScript + Vite, fully
procedural, no art assets. See [PLAN.md](PLAN.md) for the goals and milestones, and
[docs/progress](docs/progress/README.md) for the screenshot history.

**Status:** M0, M1 and M2 done: one planet you can walk on, swim in and fly around, with an
atmosphere, an ocean and a day/night cycle. Paused here so the result can be played before M3.

## Running

```bash
npm install
npm run dev
```

Open http://localhost:5173 and click into the game to capture the mouse (Esc releases it).
`npm run typecheck` type-checks everything; `npm run build` makes a production build in `dist/`.

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
| V | toggle walking ↔ free-fly (keeps the view; toggling back drops you where you are) |
| W A S D, Space / C | move, up / down; speed scales with altitude |
| Q / E | roll |
| Shift | boost ×5 |
| Mouse wheel | speed ×2 / ×0.5 |

Anywhere:

| Key | Action |
|---|---|
| T | time speed ×1 / ×10 / ×60 / ×300 (a day is 15 minutes at ×1) |
| 1 / 2 / 3 | free-fly to orbit / free-fly to the M0 test beacon 500 km out / respawn on foot |
| F2 | screenshot to `screenshots/` (dev build only) |
| F3 | debug panel |
| F4 | terrain debug view: normal → LOD colours → LOD colours + wireframe |
| H | help |

### Things to try

1. Walk down to the bay and into the water; swim out, dive with C, look up from below.
2. Jetpack up a hillside (Space in the air) and look back at the lagoon.
3. Press T a few times and watch the sun set, the sky redden and the stars come out.
4. Press V, hold Space and climb to orbit: the atmosphere becomes a glowing rim. Fly back down
   and press V near the ground to land on your feet (from high up you will fall for a while —
   use the jetpack to soften the landing).
5. F4 shows how the terrain's quadtree LOD follows you.

## Code tour

Read in this order:

1. `src/main.ts` — entry point.
2. `src/Game.ts` — owns everything and runs the frame loop:
   time → planet spin → active controller → world update → place camera → render.
3. `src/core/Universe.ts` — **camera-relative rendering**: the camera stays at the scene origin
   while the universe moves around it, so float32 precision is never a problem.
4. `src/core/ReferenceFrame.ts` — poses relative to a moving/rotating frame; the planet is one.
5. The planet, in `src/planet/`:
   - `PlanetConfig.ts` / `src/world/bodies.ts` — a planet is plain data: seed + parameters.
   - `TerrainGenerator.ts` (+ `src/math/noise.ts`) — the height function, a pure function of
     direction, shared by the Web Workers (meshes) and the main thread (collision).
   - `cubeSphere.ts` — cube-face coordinates ↔ directions on the sphere.
   - `TerrainNode.ts` + `Terrain.ts` — quadtree LOD: split/merge by distance; a parent stays
     visible until all four children are ready, so there are never holes.
   - `chunkBuilder.ts`, `chunk.worker.ts`, `ChunkWorkerPool.ts` — chunk meshes (grid + normals
     + skirts) built in Web Workers, nearest first.
   - `terrainMaterial.ts` — per-pixel biome colours, detail noise, sun + sky lighting.
   - `Planet.ts` — ties it together, spins, converts between universe and planet frame.
6. `src/controls/PlayerController.ts` — walking on a sphere: up = away from the centre,
   fixed-step physics, analytic collision, jetpack, swimming.
   `src/controls/FreeFlyController.ts` — the debug camera.
7. Rendering, in `src/render/`:
   - `RenderPipeline.ts` — scene → HDR target → composite pass → FXAA.
   - `atmosphere.ts` — Rayleigh/Mie single scattering (sky, aerial perspective, sunsets), the
     same GLSL also lights the terrain.
   - `ocean.ts` — the sea as an analytic sphere in the composite pass: depth-based colour,
     reflections, waves, foam, underwater.
   - `Starfield.ts`, `noiseGlsl.ts`; `src/world/Star.ts` — the sun.
8. `src/core/Input.ts`, `src/ui/DebugHud.ts`, `src/ui/hud.css` — input and HUD.
9. `src/dev/DevTools.ts` + `vite.config.ts` — `window.nms` console helpers: `step`, `settle`,
   `play` (drive frames by hand, even in a hidden tab) and `screenshot` (the progress history).

### Conventions

- 1 unit = 1 metre, time in seconds.
- Universe positions are float64 (plain JS numbers in `THREE.Vector3`); the GPU only ever sees
  camera-relative values. Terrain vertices are stored relative to their chunk's centre.
- Logarithmic depth buffer, so a 0.1 m near plane and a 10⁹ m far plane coexist.
  Custom shaders include three's `logdepthbuf_*` chunks so they write the same depth values.
- Procedural content is a pure function of (seed, position): no `Math.random()` in world code.
- Lighting is linear HDR everywhere; exposure, tone mapping and sRGB happen once, at the end.

## Known limitations (as of M2)

- No terrain shadows: mountains don't shadow the ground or the air, so a mountain in front of
  the setting sun still shows the sun's glow on its face.
- The ocean fills everything below sea level, including inland dips (small "puddles").
- Terrain LOD has no geomorphing: at speed you can notice chunks switching detail.
- Performance hasn't been tuned yet (by design). On an RTX 4060 a frame is ~2 ms, with an
  occasional hitch when many chunks stream in; the weak-GPU target from PLAN.md is untested.
  Easy wins for later: horizon culling (the far side of the planet is drawn), fewer
  atmosphere samples, half-resolution scattering.
- The star is fixed and the planet does not orbit yet: that's M3.
