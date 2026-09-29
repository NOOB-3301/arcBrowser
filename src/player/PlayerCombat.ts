import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Input } from '../core/Input';
import { Events } from '../core/Events';
import { Health } from '../combat/Health';
import { newTargetId, type Damageable, type DamageRegistry, type HitZone, type Surface, type Team } from '../combat/Damage';
import type { Effects } from '../combat/Effects';
import type { Ballistics } from '../weapons/Ballistics';
import { AmmoPouch, Weapon } from '../weapons/Weapon';
import { WEAPONS, type Rarity } from '../weapons/WeaponDefs';
import { buildWeaponModel } from '../weapons/WeaponModels';
import { Recoil } from '../weapons/Recoil';
import type { CameraRig } from '../camera/CameraRig';
import type { PlayerController } from './PlayerController';
import type { Animator, CombatPose } from './Animator';
import { Sfx } from '../audio/Sfx';

const HEAD: HitZone = { kind: 'head', multiplier: 1.5 };
const BODY: HitZone = { kind: 'body', multiplier: 1 };
const DEG = Math.PI / 180;
const HEAL_TIME = 2.2;
const HEAL_AMOUNT = 40;

/**
 * Player-side combat: two weapon slots, firing pipeline (muzzle → crosshair
 * convergence, spread, pellets), recoil, reload/swap, and player health.
 */
export class PlayerCombat implements Damageable {
  readonly id = newTargetId();
  readonly team: Team = 'player';
  readonly surface: Surface = 'flesh';
  readonly health = new Health(100, 60, 0.6);
  readonly pouch = new AmmoPouch();
  readonly slots: Weapon[] = [];
  active = 0;
  /** Seconds since last shot (drives hip-fire pose / facing). */
  recentFireT = 99;
  /** Current spread cone (degrees) for the crosshair. */
  spreadDeg = 0;
  healingT = -1;

  private models: THREE.Group[] = [];
  private recoil = new Recoil();
  private swapT = 0;
  private swapTotal = 0;
  private sprintFireDelay = 0;
  private kick = 0;
  private deadT = 0;
  private aim = [new THREE.Vector3(), new THREE.Vector3()];
  private camFwd = new THREE.Vector3();

  constructor(
    private player: PlayerController,
    private animator: Animator,
    private rig: CameraRig,
    private camera: THREE.PerspectiveCamera,
    private ballistics: Ballistics,
    private effects: Effects,
    registry: DamageRegistry,
    private spawn: THREE.Vector3,
  ) {
    registry.register(this, player.collider);
    this.equip(0, 'mako', 'rare');
    this.equip(1, 'wrenchback', 'common');
    this.selectSlot(0, true);

    Events.on('player:fallDamage', ({ amount }: { amount: number }) => this.takeDirect(amount));
    Events.on('weapon:reloadStart', () => Sfx.reloadStart());
    Events.on('weapon:reloadEnd', () => Sfx.reloadEnd());
    Events.on('weapon:shell', () => Sfx.shell());
    Events.on('weapon:dry', () => Sfx.dry());
    Events.on('weapon:overheat', () => Sfx.overheat());
  }

  get weapon(): Weapon {
    return this.slots[this.active];
  }

  /** Swap/reload pose for the animator. */
  get pose(): CombatPose {
    return {
      reload: this.weapon.reloading ? this.weapon.reloadProgress : this.healingT >= 0 ? this.healingT / HEAL_TIME : -1,
      swap: this.swapTotal > 0 ? Math.sin((this.swapT / this.swapTotal) * Math.PI) : 0,
      kick: this.kick,
    };
  }

  /** Character should face the camera (ADS or recent hip fire). */
  get combatFacing(): boolean {
    return this.recentFireT < 0.6;
  }

  equip(slot: number, id: string, rarity: Rarity): void {
    const def = WEAPONS[id];
    if (!def) return;
    this.slots[slot] = new Weapon(def, rarity);
    this.models[slot] = buildWeaponModel(def, rarity);
    if (slot === this.active) this.animator.setWeapon(this.models[slot]);
  }

  selectSlot(i: number, instant = false): void {
    if (i === this.active && !instant) return;
    this.weapon?.cancelReload();
    this.active = i;
    this.animator.setWeapon(this.models[i]);
    this.swapTotal = this.swapT = instant ? 0 : this.weapon.def.swapTime;
    this.healingT = -1;
    if (!instant) Sfx.swap();
    Events.emit('weapon:equipped', { weapon: this.weapon });
  }

  zoneFor(_c: RAPIER.Collider, point: THREE.Vector3): HitZone {
    return point.y - this.player.feet().y > (this.player.crouched ? 0.85 : 1.5) ? HEAD : BODY;
  }

  aimPoints(out: THREE.Vector3[]): void {
    const f = this.player.feet();
    out.push(this.aim[0].set(f.x, f.y + 1.1, f.z), this.aim[1].set(f.x, f.y + 1.65, f.z));
  }

  onDamaged(r: { dealt: number; source: { origin: THREE.Vector3 } }): void {
    Sfx.hurt();
    Events.emit('player:hurt', { amount: r.dealt, from: r.source.origin });
    this.healingT = -1;
    if (!this.health.alive) this.die();
  }

  /** Environmental damage that bypasses shields (falls). */
  takeDirect(amount: number): void {
    if (!this.health.alive) return;
    this.health.hp = Math.max(0, this.health.hp - amount);
    this.health.sinceDamage = 0;
    Events.emit('player:hurt', { amount });
    Sfx.hurt();
    if (this.health.hp <= 0) {
      this.health.alive = false;
      this.die();
    }
  }

  /** Per render frame. */
  update(dt: number, input: Input, active: boolean): void {
    this.health.update(dt);
    this.recentFireT += dt;
    this.kick = Math.max(0, this.kick - dt * 12);
    this.sprintFireDelay = Math.max(0, this.sprintFireDelay - dt);
    this.recoil.update(dt, this.rig);

    if (!this.health.alive) {
      this.deadT -= dt;
      if (this.deadT <= 0) this.respawn();
      return;
    }

    const p = this.player;
    const w = this.weapon;
    const busy = p.state === 'roll' || p.state === 'mantle' || p.state === 'ladder' || p.state === 'zipline';

    if (active) {
      if (input.pressed('slot1')) this.selectSlot(0);
      if (input.pressed('slot2')) this.selectSlot(1);
      if (input.pressed('swapWeapon')) this.selectSlot(1 - this.active);
      if (input.pressed('fireMode')) {
        const label = w.cycleMode();
        if (label) Events.emit('toast', `${w.def.name}: ${label}`);
      }
      if (input.pressed('reload') && !busy && this.swapT <= 0) w.startReload(this.pouch);
      if (input.pressed('heal')) this.tryHeal();
      if (input.pressed('fire') && p.locomotion === 'sprint') {
        p.breakSprint();
        this.sprintFireDelay = 0.12;
      }
    }

    // Swap timer
    if (this.swapT > 0) this.swapT = Math.max(0, this.swapT - dt);

    // Healing (interrupted by firing / sprinting / taking damage)
    if (this.healingT >= 0) {
      if ((active && input.down('fire')) || p.locomotion === 'sprint' || busy) this.healingT = -1;
      else {
        this.healingT += dt;
        if (this.healingT >= HEAL_TIME) {
          this.health.heal(HEAL_AMOUNT);
          this.healingT = -1;
          Events.emit('toast', `+${HEAL_AMOUNT} HP`);
        }
      }
    }

    // Handling: heavy weapons slow ADS and movement
    const heavy = Math.max(0, w.def.weight - 3);
    this.rig.zoom = w.def.adsZoom;
    this.rig.adsTime = w.def.adsTime * (1 + heavy * 0.05);
    p.speedMult = 1 - heavy * 0.012;

    const canFire = active && !busy && this.swapT <= 0 && this.sprintFireDelay <= 0 && this.healingT < 0 && p.locomotion !== 'sprint';
    const shots = w.update(
      dt,
      { down: active && input.down('fire'), pressed: active && input.pressed('fire'), released: active && input.released('fire'), canFire },
      this.pouch,
    );

    this.spreadDeg = this.computeSpread();
    for (const shot of shots) this.fire(shot);
  }

  private computeSpread(): number {
    const w = this.weapon;
    const d = w.def;
    const p = this.player;
    const ads = this.rig.ads;
    let s = THREE.MathUtils.lerp(d.hipSpread, d.adsSpread, ads);
    const speedK = Math.min(1, p.horizontalSpeed / 4.3);
    s *= 1 + (d.moveSpreadMult - 1) * speedK;
    if (!p.grounded) s *= 1.8;
    if (p.state === 'slide') s *= 1.3;
    if (p.crouched && p.state === 'ground') s *= 0.85;
    return s + w.bloom * (1 - 0.5 * ads);
  }

  private fire(shot: ReturnType<Weapon['update']>[number]): void {
    const w = this.weapon;
    const d = w.def;
    const muzzle = this.animator.muzzleWorld();
    this.camera.getWorldDirection(this.camFwd);

    // Converge from muzzle to what the crosshair is over. Very close aim points
    // (or points behind the muzzle) fall back to the camera ray.
    const aimPoint = this.rig.aimPoint;
    let base = aimPoint.clone().sub(muzzle);
    if (aimPoint.distanceTo(this.camera.position) < 2.5 || base.dot(this.camFwd) < 0.2) base = this.camFwd.clone();
    base.normalize();

    const cone = this.spreadDeg * shot.spreadMult * DEG * 0.5;
    const pellets = shot.pellets;
    for (let i = 0; i < pellets; i++) {
      this.ballistics.fire({
        origin: muzzle,
        dir: coneDirection(base, cone),
        speed: shot.muzzleVelocity,
        gravity: shot.gravity,
        damage: shot.damage,
        falloff: shot.falloff,
        penetration: d.penetration,
        headMultiplier: d.headMultiplier,
        team: 'player',
        shooter: this.player.collider,
        byPlayer: true,
        weaponId: d.id,
        color: d.tracerColor,
        heavyTracer: d.cls === 'energy' && d.chargeTime !== undefined,
        chain: d.chain,
      });
    }

    this.recoil.onShot(w, this.rig, this.rig.ads, this.player.crouched);
    this.effects.muzzleFlash(muzzle, d.tracerColor, d.suppressed ? 0.3 : d.cls === 'lmg' || d.cls === 'battle' ? 1.3 : 1);
    Sfx.shot(d.cls, d.suppressed, d.cls === 'energy');
    Events.emit('noise', { pos: muzzle.clone(), radius: d.noise, source: 'gunshot', team: 'player' });
    Events.emit('player:shot', { weapon: w });
    this.recentFireT = 0;
    this.kick = 1;
  }

  private tryHeal(): void {
    if (this.health.hp >= this.health.maxHp || this.healingT >= 0) return;
    this.weapon.cancelReload();
    this.healingT = 0;
  }

  private die(): void {
    this.deadT = 3;
    this.healingT = -1;
    Events.emit('player:died', {});
  }

  private respawn(): void {
    this.health.reset();
    this.player.teleport(this.spawn);
    for (const w of this.slots) {
      w.mag = w.magCap;
      w.heat = 0;
      w.overheated = false;
      w.cancelReload();
    }
    Events.emit('player:respawned', {});
  }
}

/** Uniform random direction within a cone of half-angle `half` around `dir`. */
function coneDirection(dir: THREE.Vector3, half: number): THREE.Vector3 {
  if (half <= 0) return dir.clone();
  const cosMax = Math.cos(half);
  const z = cosMax + (1 - cosMax) * Math.random();
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = Math.random() * Math.PI * 2;
  const local = new THREE.Vector3(r * Math.cos(phi), r * Math.sin(phi), z);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  return local.applyQuaternion(q);
}
