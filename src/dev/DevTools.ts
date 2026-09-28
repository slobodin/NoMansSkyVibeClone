import * as THREE from 'three';
import type { Game } from '../Game';

/**
 * Development helpers, exposed as `window.nms` in the dev build (open the browser console):
 *
 *   nms.game                     the Game instance - poke at anything
 *   nms.screenshot('name')       save the current frame to screenshots/ (git-ignored)
 *   nms.screenshot('name', true) save it to docs/progress/NNN-name.jpg (the progress history)
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
