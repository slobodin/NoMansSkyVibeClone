# Progress history

Screenshots taken during development, oldest first. Each one was captured from the running dev
build with `nms.screenshot('name', true)` (see `src/dev/DevTools.ts`) at 1280×720.

## M0 — Scaffold

### 001 — Placeholder planet and starfield

![001](001-m0-placeholder-planet-and-starfield.jpg)

Vite + TypeScript + three.js running. The "planet" is a plain 8 km sphere, lit by a directional
sun; the stars are ~9000 point sprites with a denser band that hints at a galactic plane.

### 002 — Test beacon 500 km from the origin

![002](002-m0-test-beacon-500km-out.jpg)

The camera-relative ("floating origin") test: a 20 m checkerboard platform with 4 cm rods and
5 cm cubes, 500 km from the universe origin. Up close it stays perfectly still — without the
floating origin world-space coordinates would be rounded to a ~3 cm float32 grid out here.

## M1 — One planet

### 003 — Verdant from orbit

![003](003-m1-verdant-from-orbit.jpg)

A 10 km planet built from six cube-face quadtrees. Height is domain-warped fBm continents +
rolling hills + ridged-noise mountain ranges; colours are picked per pixel from height, slope
and latitude (beaches, grass, forest, rock, snow, polar caps). The grey-teal basins are the
seabed: there is no water until M2.

### 004 — A mountain range from 400 m

![004](004-m1-mountain-range-from-400m.jpg)

Chunks are generated in a pool of Web Workers and streamed in nearest-first; the view is right
over a cube corner, where three faces (and quadtrees) meet — no seams.

### 005 — Same spot, LOD debug view (F4)

![005](005-m1-lod-debug-view-same-spot.jpg)

One colour per quadtree level: small, dense chunks near the camera, bigger ones further away.
Where neighbouring levels meet, skirts (strips hanging down from each chunk's border) hide the
cracks.

### 006 — Ground level

![006](006-m1-ground-level.jpg)

At ground level the finest chunks have ~1 m vertex spacing, and a few octaves of value noise in
the shader give the ground some texture (faded out with distance so it never shimmers).
