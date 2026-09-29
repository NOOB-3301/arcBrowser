/** Stamina pool with regen delay and exhaustion lockout. */
export class Stamina {
  max = 100;
  value = 100;
  /** Seconds after last spend before regen starts. */
  regenDelay = 0.9;
  regenRate = 22;
  /** Once emptied, sprint is locked until stamina climbs back to this. */
  recoverThreshold = 30;
  exhausted = false;
  regenMultiplier = 1;
  private sinceSpend = 99;

  canSpend(amount: number): boolean {
    return !this.exhausted && this.value >= amount;
  }

  /** One-shot cost (jump, roll). Returns false if unaffordable. */
  spend(amount: number): boolean {
    if (!this.canSpend(amount)) return false;
    this.value -= amount;
    this.sinceSpend = 0;
    if (this.value <= 0) {
      this.value = 0;
      this.exhausted = true;
    }
    return true;
  }

  /** Continuous drain (sprint). */
  drain(rate: number, dt: number): void {
    this.value = Math.max(0, this.value - rate * dt);
    this.sinceSpend = 0;
    if (this.value === 0) this.exhausted = true;
  }

  update(dt: number): void {
    this.sinceSpend += dt;
    if (this.sinceSpend >= this.regenDelay) {
      this.value = Math.min(this.max, this.value + this.regenRate * this.regenMultiplier * dt);
    }
    if (this.exhausted && this.value >= this.recoverThreshold) this.exhausted = false;
  }

  get fraction(): number {
    return this.value / this.max;
  }
}
