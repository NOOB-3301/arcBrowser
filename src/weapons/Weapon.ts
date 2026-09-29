import { Events } from '../core/Events';
import { RARITY, type AmmoType, type Falloff, type FireMode, type Rarity, type WeaponDef } from './WeaponDefs';

/** Reserve ammo by type. */
export class AmmoPouch {
  infinite = false;
  readonly counts: Record<AmmoType, number> = { light: 240, medium: 210, heavy: 60, shells: 42, cells: 300 };

  count(t: AmmoType): number {
    return this.infinite ? 9999 : this.counts[t];
  }

  take(t: AmmoType, n: number): number {
    if (this.infinite) return n;
    const got = Math.min(n, this.counts[t]);
    this.counts[t] -= got;
    return got;
  }
}

/** One fired trigger event; pellets > 1 for shotguns. */
export interface ShotRequest {
  pellets: number;
  damage: number;
  muzzleVelocity: number;
  gravity: number;
  falloff: Falloff;
  /** Multiplies the weapon's spread cone (slugs are tight). */
  spreadMult: number;
  /** 0..1 charge for charge weapons (1 otherwise). */
  charge: number;
}

export interface TriggerState {
  down: boolean;
  pressed: boolean;
  released: boolean;
  /** False while rolling, mantling, swapping… */
  canFire: boolean;
}

/** Runtime state of one weapon instance. Behaviour only; tuning is in WeaponDefs. */
export class Weapon {
  mag: number;
  modeIndex = 0;
  altAmmo = false;
  heat = 0;
  overheated = false;
  charge = 0;
  spin = 0;
  bloom = 0;
  shotIndex = 0;
  sinceShot = 99;

  reloading = false;
  reloadT = 0;
  reloadTotal = 0;
  private reloadPerShellMode = false;

  private nextShotT = 0;
  private burstLeft = 0;
  private semiBuffer = 0;
  private overheatT = 0;

  constructor(readonly def: WeaponDef, readonly rarity: Rarity = 'common') {
    this.mag = this.magCap;
  }

  get magCap(): number {
    return Math.round(this.def.magSize * RARITY[this.rarity].mag);
  }
  get mode(): FireMode {
    return this.def.modes[this.modeIndex];
  }
  get usesHeat(): boolean {
    return this.def.heatPerShot !== undefined;
  }
  get damage(): number {
    return this.def.damage * RARITY[this.rarity].damage;
  }
  /** 0..1 reload progress. */
  get reloadProgress(): number {
    return this.reloadTotal > 0 ? this.reloadT / this.reloadTotal : 0;
  }

  /** Fire mode button: cycle modes, or swap buckshot/slug. */
  cycleMode(): string | null {
    if (this.def.altAmmo) {
      this.altAmmo = !this.altAmmo;
      return this.altAmmo ? this.def.altAmmo.name : 'Buckshot';
    }
    if (this.def.modes.length < 2) return null;
    this.modeIndex = (this.modeIndex + 1) % this.def.modes.length;
    this.burstLeft = 0;
    return this.mode.toUpperCase();
  }

  canReload(pouch: AmmoPouch): boolean {
    return !this.usesHeat && !this.reloading && this.mag < this.magCap && pouch.count(this.def.ammo) > 0;
  }

  startReload(pouch: AmmoPouch): boolean {
    if (!this.canReload(pouch)) return false;
    this.reloading = true;
    this.burstLeft = 0;
    const speed = RARITY[this.rarity].reload;
    if (this.def.reloadPerShell) {
      this.reloadPerShellMode = true;
      this.reloadTotal = this.def.reloadPerShell * speed;
    } else {
      this.reloadPerShellMode = false;
      this.reloadTotal = (this.mag === 0 ? this.def.reloadEmpty : this.def.reloadTactical) * speed;
    }
    this.reloadT = 0;
    Events.emit('weapon:reloadStart', { weapon: this });
    return true;
  }

  cancelReload(): void {
    if (!this.reloading) return;
    this.reloading = false;
    this.reloadT = 0;
  }

  /**
   * Advance timers and fire. Returns shots fired this frame (can be several at
   * high RPM or low framerate).
   */
  update(dt: number, trig: TriggerState, pouch: AmmoPouch): ShotRequest[] {
    const shots: ShotRequest[] = [];
    const d = this.def;
    this.sinceShot += dt;
    this.nextShotT -= dt;
    if (this.sinceShot > 0.35) this.shotIndex = 0;
    if (this.sinceShot > 0.08) this.bloom = Math.max(0, this.bloom - d.bloomRecovery * dt);

    // Heat
    if (this.usesHeat) {
      if (this.overheated) {
        this.overheatT -= dt;
        this.heat = Math.max(0, this.heat - (d.heatDecay ?? 30) * dt);
        if (this.overheatT <= 0) {
          this.overheated = false;
          Events.emit('weapon:cooled', { weapon: this });
        }
      } else if (this.sinceShot > 0.3) {
        this.heat = Math.max(0, this.heat - (d.heatDecay ?? 30) * dt);
      }
    }

    // Reload
    if (this.reloading) {
      // Shell-by-shell reloads can be interrupted by the trigger
      if (this.reloadPerShellMode && trig.pressed && this.mag > 0) {
        this.cancelReload();
      } else {
        this.reloadT += dt;
        if (this.reloadT >= this.reloadTotal) {
          if (this.reloadPerShellMode) {
            this.mag += pouch.take(d.ammo, 1);
            Events.emit('weapon:shell', { weapon: this });
            if (this.mag < this.magCap && pouch.count(d.ammo) > 0) this.reloadT = 0;
            else this.finishReload();
          } else {
            this.mag += pouch.take(d.ammo, this.magCap - this.mag);
            this.finishReload();
          }
        }
        this.spin = Math.max(0, this.spin - dt);
        return shots;
      }
    }

    // Spin-up
    if (d.spinUp) {
      this.spin = trig.down && trig.canFire ? Math.min(1, this.spin + dt / d.spinUp) : Math.max(0, this.spin - dt / 1.0);
    }

    if (!trig.canFire) {
      this.charge = 0;
      this.burstLeft = 0;
      return shots;
    }

    const hasAmmo = () => (this.usesHeat ? !this.overheated && pouch.count(d.ammo) >= (d.cellsPerShot ?? 1) : this.mag > 0);
    const interval = () => {
      let rpm = d.rpm;
      if (d.spinUp) rpm = (d.spinUpStartRpm ?? rpm * 0.4) + (rpm - (d.spinUpStartRpm ?? rpm * 0.4)) * this.spin;
      return 60 / rpm;
    };

    // Dry trigger → click + auto reload
    if (trig.pressed && !hasAmmo()) {
      Events.emit('weapon:dry', { weapon: this });
      if (!this.usesHeat) this.startReload(pouch);
      return shots;
    }

    if (trig.pressed) this.semiBuffer = 0.12;
    else this.semiBuffer = Math.max(0, this.semiBuffer - dt);

    const mode = this.mode;
    if (mode === 'charge') {
      if (trig.down && hasAmmo() && this.nextShotT <= 0) {
        this.charge = Math.min(1, this.charge + dt / (d.chargeTime ?? 1));
      }
      if (trig.released && this.charge >= 0.15) {
        shots.push(this.fireOne(pouch, this.charge));
        this.charge = 0;
      } else if (!trig.down) {
        this.charge = 0;
      }
      return shots;
    }

    // Guard against piling up shots after a long idle
    if (this.nextShotT < -0.05) this.nextShotT = -0.05;

    if (mode === 'auto') {
      let guard = 0;
      while (trig.down && this.nextShotT <= 0 && hasAmmo() && guard++ < 6) {
        shots.push(this.fireOne(pouch, 1));
        this.nextShotT += d.cycleTime ?? interval();
      }
    } else if (mode === 'semi') {
      if (this.semiBuffer > 0 && this.nextShotT <= 0 && hasAmmo()) {
        this.semiBuffer = 0;
        shots.push(this.fireOne(pouch, 1));
        this.nextShotT = Math.max(this.nextShotT, 0) + (d.cycleTime ?? interval());
      }
    } else if (mode === 'burst') {
      if (this.burstLeft === 0 && this.semiBuffer > 0 && this.nextShotT <= 0 && hasAmmo()) {
        this.semiBuffer = 0;
        this.burstLeft = d.burstCount ?? 3;
      }
      let guard = 0;
      while (this.burstLeft > 0 && this.nextShotT <= 0 && guard++ < 6) {
        if (!hasAmmo()) {
          this.burstLeft = 0;
          break;
        }
        shots.push(this.fireOne(pouch, 1));
        this.burstLeft--;
        this.nextShotT += this.burstLeft > 0 ? interval() : interval() + (d.burstDelay ?? 0.2);
      }
    }

    // Auto reload when a magazine runs dry
    if (!this.usesHeat && this.mag === 0 && shots.length > 0) this.startReload(pouch);
    return shots;
  }

  private fireOne(pouch: AmmoPouch, charge: number): ShotRequest {
    const d = this.def;
    if (this.usesHeat) {
      pouch.take(d.ammo, d.cellsPerShot ?? 1);
      this.heat += d.heatPerShot! * (d.chargeTime ? 0.4 + 0.6 * charge : 1);
      if (this.heat >= 100) {
        this.heat = 100;
        this.overheated = true;
        this.overheatT = d.overheatLockout ?? 2;
        Events.emit('weapon:overheat', { weapon: this });
      }
    } else {
      this.mag--;
    }
    this.sinceShot = 0;
    this.shotIndex++;
    this.bloom = Math.min(d.bloomMax, this.bloom + d.bloom);

    const alt = this.altAmmo && d.altAmmo ? d.altAmmo : null;
    const dmgScale = d.chargeTime ? 0.35 + 0.65 * charge : 1;
    return {
      pellets: alt ? alt.pellets : d.pellets ?? 1,
      damage: (alt ? alt.damage : d.damage) * RARITY[this.rarity].damage * dmgScale,
      muzzleVelocity: alt ? alt.muzzleVelocity : d.muzzleVelocity * (d.chargeTime ? 0.6 + 0.4 * charge : 1),
      gravity: d.gravity,
      falloff: alt ? alt.falloff : d.falloff,
      spreadMult: alt ? alt.spreadMult : 1,
      charge,
    };
  }

  private finishReload(): void {
    this.reloading = false;
    this.reloadT = 0;
    this.reloadTotal = 0;
    Events.emit('weapon:reloadEnd', { weapon: this });
  }
}
