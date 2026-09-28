# NMS Clone

A small, educational No Man's Sky–style game in the browser: three.js + TypeScript + Vite, fully
procedural, no art assets. See [PLAN.md](PLAN.md) for the goals and milestones, and
[docs/progress](docs/progress/README.md) for the screenshot history.

**Status:** M0 (scaffold).

## Running

```bash
npm install
npm run dev
```

Open http://localhost:5173 and click into the game to capture the mouse (Esc releases it).
`npm run typecheck` type-checks everything; `npm run build` makes a production build in `dist/`.

## Controls

| Key | Action |
|---|---|
| Mouse | look |
| W A S D | move |
| Space / C | up / down |
| Q / E | roll |
| Shift | boost ×5 |
| Mouse wheel | speed ×2 / ×0.5 |
| 1 / 2 | jump to the planet / to the test beacon 500 km out |
| F2 | screenshot to `screenshots/` (dev build) |
| F3 | toggle the debug panel |
| H | toggle the help |

## Code tour

Read in this order:

1. `src/main.ts` — entry point.
2. `src/Game.ts` — owns the renderer, the scene and the systems; runs the frame loop
   (`update` → place camera → `render`).
3. `src/core/Universe.ts` — **camera-relative rendering**: why and how the camera stays at the
   scene origin while the universe moves around it.
4. `src/controls/FreeFlyController.ts` — the debug camera; speed proportional to distance to the
   nearest surface.
5. `src/core/Input.ts`, `src/render/Starfield.ts`, `src/ui/DebugHud.ts` — input, stars, HUD.
6. `src/dev/DevTools.ts` + `vite.config.ts` — `window.nms` console helpers and the screenshot
   endpoint used to build the progress history.

### Conventions

- 1 unit = 1 metre, time in seconds.
- Universe positions are float64 (plain JS numbers in `THREE.Vector3`); the GPU only ever sees
  camera-relative values.
- Logarithmic depth buffer, so a 0.1 m near plane and a 10⁹ m far plane coexist.
- Custom shaders include three's `logdepthbuf_*` chunks so they write the same depth values.
