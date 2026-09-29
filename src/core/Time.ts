/** Fixed-step accumulator: physics/gameplay at FIXED_DT, render at display rate. */
export const FIXED_DT = 1 / 60;
const MAX_FRAME = 0.25;

export class Time {
  elapsed = 0;
  delta = 0;
  /** Interpolation factor between last and current fixed step, 0..1. */
  alpha = 0;
  private last = performance.now();
  private accumulator = 0;

  /** Returns number of fixed steps to run this frame. */
  tick(now: number): number {
    this.delta = Math.min((now - this.last) / 1000, MAX_FRAME);
    this.last = now;
    this.elapsed += this.delta;
    this.accumulator += this.delta;
    let steps = 0;
    while (this.accumulator >= FIXED_DT) {
      this.accumulator -= FIXED_DT;
      steps++;
    }
    this.alpha = this.accumulator / FIXED_DT;
    return steps;
  }
}
