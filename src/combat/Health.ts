/**
 * Health + shield. While shield holds, it soaks `shieldAbsorb` of incoming damage
 * (the remainder still hits health) — shields reduce, not negate, like raider shields.
 */
export class Health {
  hp: number;
  shield: number;
  alive = true;
  /** Seconds since last damage (for regen / UI). */
  sinceDamage = 99;

  constructor(
    public maxHp: number,
    public maxShield = 0,
    public shieldAbsorb = 0.6,
  ) {
    this.hp = maxHp;
    this.shield = maxShield;
  }

  /** Apply raw damage; returns { toShield, toHp, killed }. */
  damage(amount: number): { toShield: number; toHp: number; killed: boolean } {
    if (!this.alive || amount <= 0) return { toShield: 0, toHp: 0, killed: false };
    this.sinceDamage = 0;
    let toShield = 0;
    if (this.shield > 0) {
      toShield = Math.min(this.shield, amount * this.shieldAbsorb);
      this.shield -= toShield;
    }
    const toHp = Math.min(this.hp, amount - toShield);
    this.hp -= toHp;
    const killed = this.hp <= 0;
    if (killed) this.alive = false;
    return { toShield, toHp, killed };
  }

  heal(amount: number): void {
    if (this.alive) this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  rechargeShield(amount: number): void {
    if (this.alive) this.shield = Math.min(this.maxShield, this.shield + amount);
  }

  update(dt: number): void {
    this.sinceDamage += dt;
  }

  reset(): void {
    this.hp = this.maxHp;
    this.shield = this.maxShield;
    this.alive = true;
    this.sinceDamage = 99;
  }
}
