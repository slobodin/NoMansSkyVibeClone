/**
 * Keyboard + mouse state, polled once per frame by whoever needs it.
 *
 * - Keys are identified by `KeyboardEvent.code` ("KeyW", "Space", "ShiftLeft", ...), i.e. by
 *   physical position, so WASD works on any keyboard layout.
 * - Mouse movement is only collected while the pointer is locked (click the game to lock it,
 *   Esc to release). This is the standard first-person setup in a browser.
 * - Everything "per frame" (mouse delta, wheel, key presses) is accumulated between frames and
 *   cleared by `endFrame()`, which the game loop calls after all systems have read the input.
 */

/** Game keys whose browser default (page scroll, focus change, caret browsing...) we suppress. */
const SUPPRESSED_BROWSER_KEYS = new Set([
  'Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F2', 'F3', 'F4', 'F7',
]);

export class Input {
  /** Mouse movement since the last frame, in pixels. */
  mouseDX = 0;
  mouseDY = 0;
  /** Wheel notches since the last frame (positive = scrolled down / towards the user). */
  wheelSteps = 0;
  pointerLocked = false;

  private readonly held = new Set<string>();
  private readonly pressed = new Set<string>();

  constructor(element: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (SUPPRESSED_BROWSER_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.held.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    // Releasing keys while the window is unfocused would otherwise leave them "stuck".
    window.addEventListener('blur', () => this.held.clear());

    element.addEventListener('click', () => {
      if (!this.pointerLocked) void element.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === element;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    element.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.wheelSteps += Math.sign(e.deltaY);
      },
      { passive: false },
    );
  }

  /** Is the key currently held down? */
  isDown(code: string): boolean {
    return this.held.has(code);
  }

  /** Was the key pressed since the previous frame? (For toggles; ignores auto-repeat.) */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  /** -1, 0 or +1 depending on which of the two keys is held. */
  axis(negative: string, positive: string): number {
    return (this.isDown(positive) ? 1 : 0) - (this.isDown(negative) ? 1 : 0);
  }

  /** Clears the per-frame accumulators. Call once at the end of every frame. */
  endFrame(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelSteps = 0;
    this.pressed.clear();
  }
}
