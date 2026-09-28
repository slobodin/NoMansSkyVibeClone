/**
 * Debug overlay (top-left). Measures frame times itself; the text comes from a callback so the
 * HUD does not need to know about the rest of the game. The DOM is refreshed a few times per
 * second only - rewriting text every frame is wasted work and unreadable anyway.
 */
export class DebugHud {
  visible = true;

  private frames = 0;
  private elapsed = 0;
  private worstFrame = 0;
  private fps = 0;
  private avgMs = 0;
  private worstMs = 0;

  constructor(
    private readonly element: HTMLElement,
    private readonly lines: () => string[],
  ) {}

  update(dt: number): void {
    this.frames++;
    this.elapsed += dt;
    this.worstFrame = Math.max(this.worstFrame, dt);
    if (this.elapsed < 0.25) return;

    this.fps = this.frames / this.elapsed;
    this.avgMs = (this.elapsed / this.frames) * 1000;
    this.worstMs = this.worstFrame * 1000;
    this.frames = 0;
    this.elapsed = 0;
    this.worstFrame = 0;

    this.element.classList.toggle('hidden', !this.visible);
    if (!this.visible) return;
    const header = `FPS ${this.fps.toFixed(0).padStart(3)}  ${this.avgMs.toFixed(1)} ms (worst ${this.worstMs.toFixed(1)})`;
    this.element.textContent = [header, ...this.lines()].join('\n');
  }
}

/** 1234.5 -> "1.235 km", 12.345 -> "12.35 m". */
export function formatDistance(metres: number): string {
  const abs = Math.abs(metres);
  if (abs >= 1e6) return `${(metres / 1000).toFixed(0)} km`;
  if (abs >= 1000) return `${(metres / 1000).toFixed(3)} km`;
  return `${metres.toFixed(2)} m`;
}

/** Speed in m/s with a sensible unit. */
export function formatSpeed(metresPerSecond: number): string {
  if (metresPerSecond >= 1000) return `${(metresPerSecond / 1000).toFixed(2)} km/s`;
  return `${metresPerSecond.toFixed(1)} m/s`;
}
