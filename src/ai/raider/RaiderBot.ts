import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { Bot } from '../Bot';
import type { AIContext } from '../AIContext';
import type { HitZone } from '../../combat/Damage';
import type { Button, Input } from '../../core/Input';
import { PlayerController } from '../../player/PlayerController';
import { Animator } from '../../player/Animator';
import { AmmoPouch, Weapon } from '../../weapons/Weapon';
import { WEAPONS, type Rarity } from '../../weapons/WeaponDefs';
import { buildWeaponModel } from '../../weapons/WeaponModels';
import { AimModel } from '../AimModel';
import { PathFollower } from '../PathFollower';
import { Action, Condition, Selector, Sequence, type BTNode, type Status } from '../BehaviorTree';
import { Events } from '../../core/Events';
import { Sfx } from '../../audio/Sfx';

const HEAD: HitZone = { kind: 'head', multiplier: 1.5 };
const BODY: HitZone = { kind: 'body', multiplier: 1 };
const DEG = Math.PI / 180;

const LOADOUTS = ['mako', 'hornet9', 'tern', 'brigand', 'ferrous', 'scattercan', 'rookhammer', 'grindstone', 'arcsplitter', 'wrenchback'];
const PALETTES = [
  { suit: '#6b7250', dark: '#2e3326', accent: '#c9b27a' },
  { suit: '#5b6b7a', dark: '#262c33', accent: '#e0c040' },
  { suit: '#8a6a4a', dark: '#3a2c22', accent: '#6fd0c0' },
  { suit: '#3e3e42', dark: '#1d1d20', accent: '#d8402a' },
  { suit: '#9a8a70', dark: '#443c30', accent: '#7aa8ff' },
];

/** Minimal Input stand-in so bots drive the exact same movement controller as the player. */
class BotInput {
  moveX = 0;
  moveY = 0;
  readonly activeDevice = 'kbm';
  private held = new Set<Button>();
  private edge = new Set<Button>();
  press(b: Button): void {
    this.edge.add(b);
  }
  hold(b: Button, on: boolean): void {
    if (on) this.held.add(b);
    else this.held.delete(b);
  }
  pressed(b: Button): boolean {
    return this.edge.has(b);
  }
  down(b: Button): boolean {
    return this.held.has(b) || this.edge.has(b);
  }
  released(): boolean {
    return false;
  }
  endFrame(): void {
    this.edge.clear();
  }
}

type MoveMode = 'walk' | 'jog' | 'sprint';

/**
 * Lone raider: roams POIs, investigates noise, fights with cover/strafe/burst
 * discipline, heals when hurt. Hostile to everyone (solo mode).
 */
export class RaiderBot extends Bot {
  readonly kind = 'raider' as const;
  readonly controller: PlayerController;
  readonly animator: Animator;
  readonly weapon: Weapon;
  private pouch = new AmmoPouch();
  private input = new BotInput();
  private aim = new AimModel();
  private follower = new PathFollower();
  private bt: BTNode<RaiderBot>;

  // Intents set by the behaviour tree each frame
  moveTarget: THREE.Vector3 | null = null;
  moveMode: MoveMode = 'jog';
  aimAt: THREE.Vector3 | null = null;
  wantFire = false;
  wantCrouch = false;
  strafeDir = 0;
  backpedal = false;

  // Behaviour state
  private strafeT = 0;
  private burstLeft = 0;
  private burstPause = 0;
  private semiT = 0;
  private coverPoint: THREE.Vector3 | null = null;
  private coverUntil = 0;
  private nextCoverSearch = 0;
  private roamGoal: THREE.Vector3 | null = null;
  private idleUntil = 0;
  private investigateHold = 0;
  private lastDamagedAt = -99;
  private medkits = 2;
  private healT = -1;
  private stuckT = 0;
  private flankPoint: THREE.Vector3 | null = null;
  private aimYaw = 0;
  private aimPitch = 0;
  private kick = 0;
  private thinkAcc = 0;
  private lookT = 0;

  constructor(ctx: AIContext, feet: THREE.Vector3, index: number) {
    super(ctx, 'raider', `raider-${index}`, 'flesh', 100, 60);
    this.controller = new PlayerController(ctx.physics, ctx.traversal, feet);
    this.controller.owner = this;
    ctx.registry.register(this, this.controller.collider);
    this.animator = new Animator(ctx.scene, PALETTES[index % PALETTES.length]);
    this.flashMats = this.animator.materials;
    const id = LOADOUTS[Math.floor(Math.random() * LOADOUTS.length)];
    const rarities: Rarity[] = ['common', 'uncommon', 'rare', 'epic'];
    const rarity = rarities[Math.min(3, Math.floor(Math.random() * 2 + ctx.difficulty.healthMult * 1.2 - 0.8))] ?? 'common';
    this.weapon = new Weapon(WEAPONS[id], rarity);
    this.animator.setWeapon(buildWeaponModel(WEAPONS[id], rarity));
    this.aimYaw = Math.random() * Math.PI * 2;
    this.bt = this.buildTree();
  }

  get body(): RAPIER.RigidBody {
    return this.controller.rigidBody;
  }

  get feet(): THREE.Vector3 {
    return this.controller.feet(this.pos);
  }

  zoneFor(_c: RAPIER.Collider, point: THREE.Vector3): HitZone {
    return point.y - this.controller.feet().y > (this.controller.crouched ? 0.85 : 1.5) ? HEAD : BODY;
  }

  aimPoints(out: THREE.Vector3[]): void {
    if (!this.health.alive) return;
    const f = this.controller.feet();
    const c = this.controller.crouched;
    out.push(this.aimPts[0].set(f.x, f.y + (c ? 0.7 : 1.1), f.z), this.aimPts[1].set(f.x, f.y + (c ? 1.0 : 1.65), f.z));
  }

  stance(): { crouched: boolean; speed: number; velocity: THREE.Vector3 } {
    return { crouched: this.controller.crouched, speed: this.controller.horizontalSpeed, velocity: this.controller.velocity };
  }

  eye(out: THREE.Vector3): THREE.Vector3 {
    const f = this.controller.feet();
    return out.set(f.x, f.y + (this.controller.crouched ? 1.0 : 1.6), f.z);
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.aimYaw), 0, -Math.cos(this.aimYaw));
  }

  onDamaged(r: Parameters<Bot['onDamaged']>[0]): void {
    super.onDamaged(r);
    this.lastDamagedAt = this.ctx.time;
    this.healT = -1;
  }

  protected onDeath(): void {
    this.controller.collider.setEnabled(false);
    Events.emit('raider:down', { bot: this });
  }

  // ================================================================ behaviour tree

  private buildTree(): BTNode<RaiderBot> {
    return new Selector<RaiderBot>([
      new Sequence([new Condition((b) => b.needsHeal()), new Action((b, dt) => b.doHeal(dt), (b) => (b.healT = -1))]),
      new Sequence([new Condition((b) => b.perception.target !== null), new Action((b, dt) => b.doCombat(dt), (b) => b.resetCombat())]),
      new Sequence([new Condition((b) => b.hasInvestigate()), new Action((b, dt) => b.doInvestigate(dt))]),
      new Action((b) => b.doRoam()),
    ]);
  }

  private needsHeal(): boolean {
    if (this.medkits <= 0 || this.health.hp > this.health.maxHp * 0.45) return false;
    if (this.perception.targetVisible) return false;
    return this.ctx.time - this.lastDamagedAt > 2 || this.healT >= 0;
  }

  private doHeal(dt: number): Status {
    this.moveTarget = null;
    this.wantFire = false;
    this.wantCrouch = true;
    if (this.healT < 0) this.healT = 0;
    this.healT += dt;
    if (this.healT >= 2.4) {
      this.health.heal(40);
      this.medkits--;
      this.healT = -1;
      return 'success';
    }
    return 'running';
  }

  private hasInvestigate(): boolean {
    const p = this.perception;
    return !!p.investigate && this.ctx.time - p.investigateAt < 25;
  }

  private doInvestigate(dt: number): Status {
    const p = this.perception.investigate!;
    this.aimAt = null;
    this.wantFire = false;
    const d = Math.hypot(p.x - this.feet.x, p.z - this.feet.z);
    if (d > 3) {
      this.moveTarget = p;
      this.moveMode = d > 40 ? 'jog' : 'walk';
      this.wantCrouch = d < 25 && Math.random() < 0.002 ? !this.wantCrouch : this.wantCrouch;
      this.investigateHold = 0;
      return 'running';
    }
    this.moveTarget = null;
    this.investigateHold += dt;
    this.lookAround(dt);
    if (this.investigateHold > 3.5) {
      this.perception.investigate = null;
      this.wantCrouch = false;
      return 'success';
    }
    return 'running';
  }

  private doRoam(): Status {
    const t = this.ctx.time;
    this.aimAt = null;
    this.wantFire = false;
    this.wantCrouch = false;
    if (t < this.idleUntil) {
      this.moveTarget = null;
      this.lookAround(1 / 60);
      return 'running';
    }
    if (!this.roamGoal || Math.hypot(this.roamGoal.x - this.feet.x, this.roamGoal.z - this.feet.z) < 4 || this.follower.failed) {
      if (this.roamGoal) this.idleUntil = t + 4 + Math.random() * 6; // "looting"
      const pts = this.ctx.roamPoints;
      const pick = pts[Math.floor(Math.random() * pts.length)];
      this.roamGoal = pick ? pick.clone().add(new THREE.Vector3((Math.random() - 0.5) * 30, 0, (Math.random() - 0.5) * 30)) : null;
      this.follower.clear();
    }
    this.moveTarget = this.roamGoal;
    const far = this.roamGoal ? this.follower.remaining(this.feet) > 70 : false;
    this.moveMode = far && this.controller.stamina.fraction > 0.5 ? 'sprint' : 'jog';
    return 'running';
  }

  private resetCombat(): void {
    this.wantFire = false;
    this.coverPoint = null;
    this.flankPoint = null;
    this.strafeDir = 0;
    this.backpedal = false;
    this.aimAt = null;
  }

  private effectiveRange(): number {
    return THREE.MathUtils.clamp(this.weapon.def.falloff.end * 0.9, 14, 140);
  }

  private doCombat(dt: number): Status {
    const ctx = this.ctx;
    const d = ctx.difficulty;
    const tgt = this.perception.target!;
    const info = this.perception.info(tgt);
    if (!info) return 'failure';
    const feet = this.feet;
    const tp = info.lastPos;
    const dist = tp.distanceTo(feet);
    const visible = info.visible;
    const reacted = ctx.time - this.perception.alertedAt > d.reactionTime;
    const range = this.effectiveRange();
    this.aimAt = tp;
    this.backpedal = false;

    // ---- cover: go there, crouch, reload, then peek out
    if (this.coverPoint) {
      const cd = Math.hypot(this.coverPoint.x - feet.x, this.coverPoint.z - feet.z);
      if (cd > 1.2) {
        this.moveTarget = this.coverPoint;
        this.moveMode = 'sprint';
        this.wantFire = false;
        this.wantCrouch = false;
        return 'running';
      }
      this.moveTarget = null;
      this.wantCrouch = true;
      this.wantFire = false;
      if (this.weapon.mag < this.weapon.magCap * 0.7) this.weapon.startReload(this.pouch);
      if (ctx.time > this.coverUntil && !this.weapon.reloading) {
        this.coverPoint = null;
        this.wantCrouch = false;
      }
      return 'running';
    }
    const hurtRecently = ctx.time - this.lastDamagedAt < 1.2;
    if (hurtRecently && ctx.time > this.nextCoverSearch && this.health.hp < this.health.maxHp * 0.75 && Math.random() > d.aggression * 0.6) {
      this.nextCoverSearch = ctx.time + 2.5;
      const cover = this.findCover(tp);
      if (cover) {
        this.coverPoint = cover;
        this.coverUntil = ctx.time + 1.5 + Math.random() * 1.5;
        return 'running';
      }
    }

    if (visible) {
      this.flankPoint = null;
      // Close the distance if out of range, back off if too close for a long gun
      if (dist > range * 1.8) {
        this.moveTarget = tp;
        this.moveMode = 'sprint';
      } else if (dist > range) {
        this.moveTarget = tp;
        this.moveMode = 'walk';
      } else {
        this.moveTarget = null;
        if (dist < 7 && this.weapon.def.falloff.start > 30) this.backpedal = true;
        this.strafeT -= dt;
        if (this.strafeT <= 0) {
          this.strafeT = 0.8 + Math.random() * 1.4;
          this.strafeDir = [-1, 0, 1][Math.floor(Math.random() * 3)];
          this.wantCrouch = this.strafeDir === 0 && dist > 20 && Math.random() < 0.35;
        }
      }
      const canShoot = reacted && dist < range * 1.4 && this.moveMode !== 'sprint' || (reacted && !this.moveTarget);
      this.fireControl(dt, canShoot);
    } else {
      this.wantFire = false;
      this.strafeDir = 0;
      if (this.weapon.mag < this.weapon.magCap * 0.6) this.weapon.startReload(this.pouch);
      const age = ctx.time - info.lastSeen;
      if (age < 2.5) {
        this.moveTarget = null;
      } else {
        if (!this.flankPoint) {
          // Aggressive bots swing wide to flank the last known position
          const side = new THREE.Vector3(tp.z - feet.z, 0, -(tp.x - feet.x)).normalize();
          const offset = Math.random() < d.aggression ? (Math.random() < 0.5 ? -1 : 1) * 14 : 0;
          this.flankPoint = tp.clone().addScaledVector(side, offset);
        }
        this.moveTarget = this.flankPoint;
        this.moveMode = dist > 30 ? 'jog' : 'walk';
        if (Math.hypot(this.flankPoint.x - feet.x, this.flankPoint.z - feet.z) < 3) {
          // Lost them: drop to suspicion and investigate
          info.level = 0.6;
          info.confirmed = false;
          this.perception.setInvestigate(tp, ctx.time);
          this.perception.target = null;
          this.flankPoint = null;
          return 'success';
        }
      }
    }
    return 'running';
  }

  private fireControl(dt: number, canShoot: boolean): void {
    const d = this.ctx.difficulty;
    this.burstPause -= dt;
    if (!canShoot) {
      this.wantFire = false;
      return;
    }
    if (this.burstLeft <= 0 && this.burstPause <= 0) {
      const semi = this.weapon.mode !== 'auto';
      this.burstLeft = semi ? 1 + Math.floor(Math.random() * 3) : 2 + Math.floor(Math.random() * (d.burstMax - 1));
      this.aim.newBurst(d);
    }
    this.wantFire = this.burstLeft > 0;
  }

  /** Nearby walkable point hidden from the threat at chest height. */
  private findCover(threat: THREE.Vector3): THREE.Vector3 | null {
    const ctx = this.ctx;
    const feet = this.feet;
    let best: THREE.Vector3 | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + Math.random() * 0.3;
      const r = 3 + Math.random() * 11;
      const p = ctx.nav.nearestWalkable(feet.x + Math.cos(a) * r, feet.z + Math.sin(a) * r, 2);
      if (!p) continue;
      const chest = p.clone().add(new THREE.Vector3(0, 0.9, 0));
      const dir = chest.clone().sub(threat);
      const len = dir.length();
      const hit = ctx.physics.raycast(threat.clone(), dir.divideScalar(len), len - 0.5, undefined, this.body);
      if (!hit || ctx.registry.lookup(hit.collider)) continue; // exposed, or only a body in the way
      const score = p.distanceTo(feet) + Math.abs(len - 20) * 0.2;
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  private lookAround(dt: number): void {
    this.lookT -= dt;
    if (this.lookT <= 0) {
      this.lookT = 1.5 + Math.random() * 2;
      this.aimYaw += (Math.random() - 0.5) * 2.2;
    }
  }

  // ================================================================ per-frame

  think(dt: number): void {
    if (!this.health.alive) return;
    // AI LOD: far bots decide less often
    this.thinkAcc += dt;
    const interval = this.focusDist > 250 ? 0.25 : 0;
    if (this.thinkAcc < interval) return;
    const tdt = this.thinkAcc;
    this.thinkAcc = 0;

    const ctx = this.ctx;
    const eye = this.eye(new THREE.Vector3());
    this.perception.update(ctx, tdt, eye, this.forward(new THREE.Vector3()));
    this.aim.update(tdt, this.perception.target, this.perception.targetVisible, ctx.difficulty);
    this.bt.tick(this, tdt);
    this.applyMovement(tdt, eye);
    this.fireWeapon(tdt, eye);
  }

  private applyMovement(dt: number, eye: THREE.Vector3): void {
    const ctx = this.ctx;
    const c = this.controller;
    const inp = this.input;
    const feet = this.feet;
    inp.moveX = 0;
    inp.moveY = 0;
    let moveYaw = this.aimYaw;

    if (this.aimAt) {
      const to = this.aimAt.clone().sub(eye);
      this.aimYaw = Math.atan2(-to.x, -to.z);
      this.aimPitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
    } else {
      this.aimPitch *= 0.9;
    }

    let moving = false;
    if (this.moveTarget) {
      this.follower.setGoal(ctx.nav, feet, this.moveTarget, ctx.time);
      const wp = this.follower.current(feet, 1.1);
      if (wp) {
        moveYaw = Math.atan2(-(wp.x - feet.x), -(wp.z - feet.z));
        inp.moveY = 1;
        moving = true;
        if (!this.aimAt) this.aimYaw = moveYaw;
      }
    } else if (this.backpedal) {
      moveYaw = this.aimYaw;
      inp.moveY = -1;
      moving = true;
    } else if (this.strafeDir !== 0 && this.aimAt) {
      moveYaw = this.aimYaw;
      inp.moveX = this.strafeDir;
      moving = true;
    }

    const sprint = this.moveMode === 'sprint' && moving && !this.wantFire;
    inp.hold('sprint', sprint);
    const wantCrouch = this.wantCrouch && !sprint;
    if (wantCrouch !== c.crouched && c.state === 'ground') inp.press('crouch');

    // Stuck: try to mantle/vault, then re-path
    if (moving && c.horizontalSpeed < 0.4 && c.state === 'ground') {
      this.stuckT += dt;
      if (this.stuckT > 1.0 && this.stuckT - dt <= 1.0) inp.press('jump');
      if (this.stuckT > 2.5) {
        this.stuckT = 0;
        if (this.moveTarget) this.follower.setGoal(ctx.nav, feet, this.moveTarget, ctx.time, true);
      }
    } else {
      this.stuckT = 0;
    }

    const aiming = !!this.aimAt && (this.wantFire || this.perception.targetVisible) && !sprint;
    c.frameInput(inp as unknown as Input, moveYaw, this.aimYaw, aiming, dt);
    inp.endFrame();
  }

  private fireWeapon(dt: number, eye: THREE.Vector3): void {
    const ctx = this.ctx;
    const d = ctx.difficulty;
    const w = this.weapon;
    const c = this.controller;
    this.kick = Math.max(0, this.kick - dt * 10);
    const busy = c.state === 'roll' || c.state === 'mantle' || c.state === 'ladder' || c.state === 'zipline' || c.locomotion === 'sprint';
    let pressed = false;
    this.semiT -= dt;
    if (this.wantFire && this.burstLeft > 0 && w.mode !== 'auto' && this.semiT <= 0) {
      pressed = true;
      this.semiT = Math.max(60 / w.def.rpm, w.def.cycleTime ?? 0) * (1.2 + Math.random() * 0.6);
    }
    const shots = w.update(dt, { down: this.wantFire && w.mode === 'auto', pressed, released: false, canFire: !busy && this.healT < 0 }, this.pouch);
    if (w.mag === 0 && !w.reloading) w.startReload(this.pouch);

    const tgt = this.perception.target;
    const info = tgt ? this.perception.info(tgt) : undefined;
    for (const shot of shots) {
      this.burstLeft--;
      if (this.burstLeft <= 0) this.burstPause = 0.25 + Math.random() * 0.45;
      if (!info || !tgt) continue;
      const muzzle = this.animator.muzzleWorld();
      const pts: THREE.Vector3[] = [];
      tgt.aimPoints(pts);
      const chest = info.visible && pts[0] ? pts[0] : info.lastPos;
      const head = info.visible ? pts[1] : undefined;
      const moveErr = c.horizontalSpeed * 0.5 + (c.crouched ? -0.3 : 0);
      const base = this.aim.direction(muzzle, chest, head, info.velocity, shot.muzzleVelocity, d, Math.max(0, moveErr));
      const spread = w.def.pellets ? w.def.hipSpread * shot.spreadMult : 0;
      for (let i = 0; i < shot.pellets; i++) {
        const dir = spread > 0 ? jitter(base, spread * 0.5 * DEG) : base;
        ctx.ballistics.fire({
          origin: muzzle,
          dir,
          speed: shot.muzzleVelocity,
          gravity: shot.gravity,
          damage: shot.damage * d.damageMult,
          falloff: shot.falloff,
          penetration: w.def.penetration,
          headMultiplier: w.def.headMultiplier,
          team: 'raider',
          faction: this.faction,
          attacker: this,
          shooter: c.collider,
          byPlayer: false,
          weaponId: w.def.id,
          color: w.def.tracerColor,
          chain: w.def.chain,
        });
      }
      ctx.effects.muzzleFlash(muzzle, w.def.tracerColor, w.def.suppressed ? 0.3 : 1);
      Sfx.shot(w.def.cls, w.def.suppressed, w.def.cls === 'energy', muzzle);
      Events.emit('noise', { emitter: this, pos: muzzle.clone(), radius: w.def.noise, source: 'gunshot' });
      this.kick = 1;
    }
    void eye;
  }

  fixedStep(): void {
    if (!this.health.alive) return;
    this.controller.step();
  }

  render(dt: number, alpha = 1): void {
    this.controller.interpolate(alpha);
    const w = this.weapon;
    this.animator.dead = !this.health.alive; // W2
    this.animator.update(dt, this.controller, this.aimPitch, {
      reload: w.reloading ? w.reloadProgress : this.healT >= 0 ? this.healT / 2.4 : -1,
      swap: 0,
      kick: this.kick,
    });
    this.updateFlash(dt);
  }

  dispose(): void {
    if (this.removed) return;
    super.dispose();
    this.ctx.scene.remove(this.animator.root);
  }
}

function jitter(dir: THREE.Vector3, half: number): THREE.Vector3 {
  const r = half * Math.sqrt(Math.random());
  const phi = Math.random() * Math.PI * 2;
  const up = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const a = new THREE.Vector3().crossVectors(dir, up).normalize();
  const b = new THREE.Vector3().crossVectors(dir, a);
  return dir.clone().addScaledVector(a, Math.cos(phi) * Math.tan(r)).addScaledVector(b, Math.sin(phi) * Math.tan(r)).normalize();
}
