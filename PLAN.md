# NMS-clone — game plan

A small No Man's Sky–style game: one star system you can cross seamlessly — stand on a planet,
board your ship, take off through the atmosphere, fly to another planet or moon, land, walk.
No loading screens.

## Decisions

| Topic | Decision |
|---|---|
| Stack | Three.js (WebGLRenderer, GLSL) + TypeScript, Vite, runs in the browser |
| Terrain | Height-based cube-sphere with quadtree LOD (no voxels / caves) |
| Precision | Camera-relative rendering (floating origin) from day one |
| Orbits | On rails — position is a pure function of time; no n-body physics |
| Scale | Compressed like NMS: planets ~5–15 km radius, system a few hundred km |
| View | First person on foot, cockpit/chase camera in the ship |
| Look | Stylised, vivid, fully procedural — no external art assets at first |
| Scope | Single player, one star system, keyboard + mouse |
| Perf target | Smooth on a 2020 Intel MacBook Air (Iris Plus, pixel ratio 1) |

## The system

One star, 4 planets, 3 moons. Each body = seed + biome preset + a few parameters, so adding
more is a config entry.

| Body | Orbits | Look & feel | Hazard |
|---|---|---|---|
| Ember | star (closest) | red rock and dunes, glowing lava cracks, orange haze | heat |
| **Verdant** (start) | star | green hills, oceans, trees, blue sky | — |
| ↳ Lull | Verdant | grey craters, no air: black sky and stars at noon, low gravity | vacuum |
| Rime | star | ice plains and spires, pale sky, snow | cold |
| ↳ Sulfa | Rime | yellow sulfur vents, toxic green haze | toxic |
| Nyx | star (ringed) | purple crystal flora glowing at night, rings across the sky | — |
| ↳ Shard | Nyx | tiny jagged crystal moon | — |

## Technical conventions

- **Units:** 1 unit = 1 metre, time in seconds.
- **Universe space** uses JS doubles. The GPU never sees universe coordinates: the camera sits at
  the scene origin and a `universeRoot` group is offset by −camera every frame. three.js composes
  matrices in float64 on the CPU, so everything uploaded is camera-relative and small.
- **Terrain vertices** are stored relative to their chunk centre.
- **Depth:** logarithmic depth buffer (near/far ratio is planet-scale).
- **Determinism:** all procedural content is a pure function of (body seed, position), in shared
  modules that run both in Web Workers (mesh generation) and on the main thread (collision).
- **Collision** against planets is analytic (height function), no physics engine. Add Rapier only
  if props/ship collisions need it.
- **HUD/UI** is plain HTML/CSS over the canvas.

## Milestones

Each ends in something playable. Nothing past M4 until fly → land → walk feels good.

- [ ] **M0 — Scaffold:** Vite + TS + three, render loop, camera-relative rendering, free-fly camera
      (speed scales with altitude), starfield, debug HUD. Fly 500 km out with no jitter.
- [ ] **M1 — One planet:** cube-sphere quadtree LOD, chunks built in a worker pool, noise terrain
      (continents, ridged mountains), colours by height/slope/latitude, skirts against cracks.
      Dive from orbit to the ground with no loading or gaps.
- [ ] **M2 — On foot:** spherical gravity, first-person walk/sprint/jump/jetpack, terrain collision,
      atmosphere scattering, ocean, day/night from planet spin.
- [ ] **M3 — Solar system:** star + all bodies from config, on-rails orbits and spin, reference-frame
      switching (sphere of influence), distant-body LOD.
- [ ] **M4 — Ship (MVP):** enter/exit, takeoff/landing, atmospheric vs space flight, pulse drive,
      HUD markers. Take off from Verdant, fly to Lull, land, get out, walk.
- [ ] **M5 — Distinct worlds:** biome presets per body, craters, instanced rocks/plants/crystals,
      clouds, Nyx's rings.
- [ ] **M6 — Gameplay loop:** scanner and discoveries, mining, inventory, fuel/refuel, hazards and
      life support, save/load.
- [ ] **M7 — Polish:** audio, post-effects, menus, settings, performance pass.

Later: creatures, space station, more star systems with a warp drive.

## Main risks

- **LOD seams / popping** → skirts first, CDLOD-style vertex morphing if popping is visible.
- **Reference-frame bugs** with moving, spinning bodies → spin first (M2), orbits after (M3).
- **Frame spikes from chunk generation** → workers + a per-frame budget for mesh uploads.
- **Weak GPU** → pixel ratio 1, cheap shaders, no shadow cascades by default, instancing.
