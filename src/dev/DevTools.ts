import * as THREE from 'three';
import type { Game } from '../Game';

/**
 * Development helpers, exposed as `window.nms` in the dev build (open the browser console):
 *
 *   nms.game                     the Game instance - poke at anything
 *   nms.screenshot('name')       save the current frame to screenshots/ (git-ignored)
 *   nms.screenshot('name', true) save it to docs/progress/NNN-name.jpg (the progress history)
 *   nms.step(frames, dt)         run frames by hand (works even while the tab is hidden)
 *   await nms.settle()           run frames until the terrain has finished streaming
 *   await nms.play(3, ['KeyW'], (t) => ...)
 *                                run 3 s of real-time frames with W held; the callback runs
 *                                after every frame (e.g. to take screenshots along the way)
 *
 * Screenshots are POSTed to a tiny endpoint in vite.config.ts that writes the file to disk.
 * F2 in game takes an ad-hoc screenshot.
 */
export function installDevTools(game: Game): void {
  if (!import.meta.env.DEV) return;
  const api = {
    game,
    THREE,
    screenshot: (name: string, history = false) => saveScreenshot(game, name, history),
    step: (frames = 1, dt = 1 / 60) => {
      for (let i = 0; i < frames; i++) game.tick(dt);
    },
    settle: (maxFrames = 2000) => settle(game, maxFrames),
    play: (seconds: number, keys: string[] = [], onFrame?: (elapsed: number) => void | Promise<void>) =>
      play(game, seconds, keys, onFrame),
  };
  (window as unknown as { nms: typeof api }).nms = api;
}

export async function saveScreenshot(game: Game, name: string, history: boolean): Promise<string> {
  const dataUrl = game.captureFrame();
  const response = await fetch('/__screenshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, dataUrl, history }),
  });
  if (!response.ok) throw new Error(`screenshot failed: ${await response.text()}`);
  const { file } = (await response.json()) as { file: string };
  console.info(`screenshot saved: ${file}`);
  return file;
}

/**
 * Ticks the game (with dt = 0, so nothing moves) until the terrain has nothing left to build.
 * Between ticks we yield to the event loop so worker results can arrive. A MessageChannel is used
 * for that instead of setTimeout because browsers throttle timers in hidden tabs.
 */
async function settle(game: Game, maxFrames: number): Promise<number> {
  let quietFrames = 0;
  for (let frame = 0; frame < maxFrames; frame++) {
    game.tick(0);
    quietFrames = game.planet.terrain.busy ? 0 : quietFrames + 1;
    if (quietFrames >= 3) return frame;
    await yieldToEventLoop();
  }
  return maxFrames;
}

/**
 * Runs the game in real time for `seconds` with `keys` held, independent of requestAnimationFrame
 * (which does not fire while the tab is hidden). Frames are paced at ~60 Hz so the terrain
 * streaming sees realistic timing.
 */
async function play(
  game: Game,
  seconds: number,
  keys: string[],
  onFrame?: (elapsed: number) => void | Promise<void>,
): Promise<void> {
  game.stop();
  for (const code of keys) window.dispatchEvent(new KeyboardEvent('keydown', { code }));
  const start = performance.now();
  let last = start;
  try {
    while (performance.now() - start < seconds * 1000) {
      await yieldToEventLoop();
      const now = performance.now();
      if (now - last < 1000 / 60) continue;
      game.tick(Math.min((now - last) / 1000, 0.1));
      last = now;
      await onFrame?.((now - start) / 1000);
    }
  } finally {
    for (const code of keys) window.dispatchEvent(new KeyboardEvent('keyup', { code }));
    game.start();
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}
