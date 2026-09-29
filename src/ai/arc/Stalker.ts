import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { RAPIER as R, Groups, interactionGroups } from '../../physics/Physics';
import { Bot } from '../Bot';
import type { AIContext } from '../AIContext';
import type { DamageResult, HitZone } from '../../combat/Damage';
import { PathFollower } from '../PathFollower';
import { stalkerModel, placeBetween, type StalkerModel } from './ArcModels2';
import { groundY } from './ArcWeapons';
import { WalkerLegs } from './WalkerLegs';
import { beamDamage } from './ArcLaser';
import { explode } from '../../combat/Explosions';
import { Events } from '../../core/Events';
import { Sfx } from '../../audio/Sfx';

const HULL: HitZone = { kind: 'armor', multiplier: 1, armor: 0.7 };
const KNEE: HitZone = { kind: 'weakpoint', multiplier: 2 };
const BODY_H = 2.35;
const PATROL_SPEED = 2.2;
const CHASE_SPEED = 4.4;
const TURN = 1.6;
const LEG_HP = 110;
const CHARGE_T = 1.0;
const FIRE_T = 1.5;
const SWEEP = 0.34; // rad either side of the target
const LASER_DPS = 140;
const LASER_RANGE = 70;
const STOMP_RANGE = 5.5;
const STOMP_WINDUP = 0.6;

type Mode = 'patrol' | 'investigate' | 'combat';
type Attack = 'none' | 'charge' | 'fire' | 'stomp';

/**
 * W4 — quadruped walker. Armoured hull; the four knee joints are weak points
 * with their own HP. Two legs down slows it, three cripples it. Attacks with a
 * telegraphed laser sweep at range and a stomp shockwave up close.
 */
export class Stalker extends Bot {
  readonly kind = 'stalker' as const;
  private _body: RAPIER.RigidBody;
  private hullCol: RAPIER.Collider;
  private kneeCols: RAPIER.Collider[] = [];
  private legHp: number[];
  private model: StalkerModel;
  private legs: WalkerLegs;
  private heading: number;
  private vel = new THREE.Vector3();
  private desired = new THREE.Vector3();
  private follower = new PathFollower();
  private mode: Mode = 'patrol';
  private attack: Attack = 'none';
  private attackT = 0;
  private laserCd = 1.5;
  private stompCd = 0;
  private sweepYaw = 0;
  private sweepPitch = 0;
  private sweepDir = 1;
  private beamEnd = new THREE.Vector3();
  private sparkT = 0;
  private home: THREE.Vector3;
  private patrolT = 0;
  private lastHit = -1;
  private bodyY: number;
  private tilt = new THREE.Euler();
  private hips: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private _q = new THREE.Quaternion();

  constructor(ctx: AIContext, pos: THREE.Vector3, facing = 0) {
    super(ctx, 'arc', 'arc', 'machine', 500);
    this.pos.copy(pos);
    this.home = pos.clone();
    this.heading = facing;
    this.bodyY = pos.y + BODY_H;
    this.legHp = [0, 0, 0, 0].map(() => LEG_HP * ctx.difficulty.healthMult);
    this._body = ctx.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z));
    const g = interactionGroups(Groups.BOT, 0xffff);
    this.hullCol = ctx.physics.world.createCollider(R.ColliderDesc.cuboid(0.95, 0.55, 1.45).setTranslation(0, BODY_H, 0).setCollisionGroups(g), this._body);
    const head = ctx.physics.world.createCollider(R.ColliderDesc.cuboid(0.45, 0.3, 0.45).setTranslation(0, BODY_H + 0.15, -1.3).setCollisionGroups(g), this._body);
    for (let i = 0; i < 4; i++) {
      this.kneeCols.push(ctx.physics.world.createCollider(R.ColliderDesc.ball(0.3).setTranslation(0, BODY_H, 0).setCollisionGroups(g), this._body));
    }
    ctx.registry.register(this, this.hullCol, head, ...this.kneeCols);
    this.model = stalkerModel();
    this.flashMats = this.model.mats;
    this.group.add(this.model.root);
    this.legs = new WalkerLegs(
      {
        rest: [new THREE.Vector3(-1.7, 0, -1.5), new THREE.Vector3(1.7, 0, -1.5), new THREE.Vector3(-1.7, 0, 1.7), new THREE.Vector3(1.7, 0, 1.7)],
        upper: 1.55,
        lower: 2.05,
        stride: 1.1,
        stepTime: 0.32,
        stepHeight: 0.45,
        groups: [[0, 3], [1, 2]],
      },
      (x, z, y) => groundY(ctx, this, x, y + 1, z),
      pos,
      facing,
    );
    this.legs.onStep = (_i, p) => {
      if (this.focusDist < 40) Sfx.stomp(p, 0.35);
    };
    this.perception.opts.range *= 1.15;
    this.perception.opts.fovDeg = 120;
  }

  get body(): RAPIER.RigidBody {
    return this._body;
  }

  get legsAlive(): number {
    return this.legs.alive.filter(Boolean).length;
  }

  private get speedMult(): number {
    const n = this.legsAlive;
    return n >= 3 ? 1 : n === 2 ? 0.45 : 0.12;
  }

  get crippled(): boolean {
    return this.legsAlive <= 1;
  }

  zoneFor(c: RAPIER.Collider): HitZone {
    this.lastHit = this.kneeCols.findIndex((k) => k.handle === c.handle);
    return this.lastHit >= 0 ? KNEE : HULL;
  }

  aimPoints(out: THREE.Vector3[]): void {
    if (this.health.alive) out.push(this.aimPts[0].set(this.pos.x, this.bodyY, this.pos.z));
  }

  eye(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x - Math.sin(this.heading) * 1.6, this.bodyY + 0.2, this.pos.z - Math.cos(this.heading) * 1.6);
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.heading), -0.1, -Math.cos(this.heading)).normalize();
  }

  onDamaged(r: DamageResult): void {
    const leg = this.lastHit;
    this.lastHit = -1;
    if (leg >= 0 && r.zone === KNEE && this.legs.alive[leg]) {
      this.legHp[leg] -= r.dealt;
      if (this.legHp[leg] <= 0) this.breakLeg(leg);
    }
    super.onDamaged(r);
  }

  private breakLeg(i: number): void {
    this.legs.alive[i] = false;
    this.kneeCols[i].setEnabled(false);
    const lp = this.model.legs[i];
    lp.lower.visible = false;
    lp.foot.visible = false;
    lp.kneeMat.emissiveIntensity = 0;
    lp.kneeMat.color.set('#222');
    this.ctx.effects.explosion(this.legs.knees[i].clone(), 0.35);
    Sfx.explosion(this.legs.knees[i], 0.4);
    if (this.legsAlive <= 2) Events.emit('toast', this.crippled ? 'Stalker crippled' : 'Stalker leg destroyed');
  }

  // ---------------------------------------------------------------- AI

  think(dt: number): void {
    if (!this.health.alive) return;
    const ctx = this.ctx;
    const eye = this.eye(new THREE.Vector3());
    this.perception.update(ctx, dt, eye, this.forward(new THREE.Vector3()));
    const tp = this.perception.targetPos();
    const visible = this.perception.targetVisible;
    this.laserCd -= dt;
    this.stompCd -= dt;
    this.desired.set(0, 0, 0);

    if (tp) this.mode = 'combat';
    else if (this.perception.investigate && ctx.time - this.perception.investigateAt < 15) this.mode = 'investigate';
    else this.mode = 'patrol';

    // Ongoing attack takes priority
    if (this.attack !== 'none') {
      this.runAttack(dt, tp, eye);
      return;
    }

    if (this.mode === 'combat' && tp) {
      const dist = Math.hypot(tp.x - this.pos.x, tp.z - this.pos.z);
      const want = Math.atan2(-(tp.x - this.pos.x), -(tp.z - this.pos.z));
      if (dist < STOMP_RANGE && this.stompCd <= 0 && this.legsAlive >= 2 && Math.abs(tp.y - this.pos.y) < 3) {
        this.attack = 'stomp';
        this.attackT = 0;
        Sfx.servo(this.pos);
        return;
      }
      const facing = Math.abs(angleDiff(want, this.heading)) < 0.35;
      if (visible && dist < LASER_RANGE * 0.8 && this.laserCd <= 0 && facing && ctx.time - this.perception.alertedAt > ctx.difficulty.reactionTime) {
        this.startLaser(tp, eye);
        return;
      }
      if (dist > 14 || !visible) {
        this.follower.setGoal(ctx.nav, this.pos, tp, ctx.time);
        this.steer(CHASE_SPEED, dt);
      } else {
        this.turnTo(want, dt);
      }
    } else if (this.mode === 'investigate') {
      this.follower.setGoal(ctx.nav, this.pos, this.perception.investigate!, ctx.time);
      if (this.follower.done && this.follower.goal && this.follower.goal.distanceTo(this.perception.investigate!) < 2) this.perception.investigate = null;
      this.steer(PATROL_SPEED * 1.3, dt);
    } else {
      this.patrolT -= dt;
      if (this.patrolT <= 0 || this.follower.done) {
        this.patrolT = 8 + Math.random() * 8;
        const a = Math.random() * Math.PI * 2;
        const r = 10 + Math.random() * 25;
        const goal = this.home.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
        this.follower.setGoal(ctx.nav, this.pos, goal, ctx.time, true);
      }
      this.steer(PATROL_SPEED, dt);
    }
  }

  private startLaser(tp: THREE.Vector3, eye: THREE.Vector3): void {
    this.attack = 'charge';
    this.attackT = 0;
    const to = tp.clone().sub(eye);
    this.sweepDir = Math.random() < 0.5 ? 1 : -1;
    this.sweepYaw = Math.atan2(-to.x, -to.z) - SWEEP * this.sweepDir;
    this.sweepPitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
    Sfx.laserCharge(this.pos, CHARGE_T);
  }

  private runAttack(dt: number, tp: THREE.Vector3 | null, eye: THREE.Vector3): void {
    const ctx = this.ctx;
    this.attackT += dt;
    if (this.attack === 'charge') {
      // Track the target's height while charging; yaw is locked for the sweep
      if (tp) this.sweepPitch = Math.atan2(tp.y - eye.y, Math.hypot(tp.x - eye.x, tp.z - eye.z));
      if (this.attackT >= CHARGE_T) {
        this.attack = 'fire';
        this.attackT = 0;
        Sfx.laserFire(this.pos, FIRE_T);
      }
    } else if (this.attack === 'fire') {
      this.sweepYaw += this.sweepDir * ((SWEEP * 2) / FIRE_T) * dt;
      const dir = this.laserDir(new THREE.Vector3());
      const muzzle = this.muzzleWorld(new THREE.Vector3());
      const r = beamDamage(ctx, this, muzzle, dir, LASER_RANGE, 0.9, LASER_DPS * ctx.difficulty.damageMult * dt, this.beamEnd);
      this.sparkT -= dt;
      if (this.sparkT <= 0 && r.normal) {
        this.sparkT = 0.05;
        ctx.effects.impact(this.beamEnd.clone(), r.normal, 'metal', true);
      }
      if (this.attackT >= FIRE_T) {
        this.attack = 'none';
        this.laserCd = 3 + Math.random() * 2;
      }
    } else if (this.attack === 'stomp') {
      if (this.attackT >= STOMP_WINDUP) {
        const p = this.pos.clone().add(new THREE.Vector3(0, 0.5, 0));
        explode(ctx.physics, ctx.registry, ctx.effects, p, {
          radius: 5, damage: 55 * ctx.difficulty.damageMult, faction: 'arc', team: 'arc', size: 0.8, excludeBody: this._body, attacker: this,
        });
        Sfx.stomp(p, 1.5);
        this.attack = 'none';
        this.stompCd = 3.2;
      }
    }
    void eye;
  }

  private muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.model.hull.updateMatrixWorld();
    return out.copy(this.model.muzzle).applyMatrix4(this.model.hull.matrixWorld);
  }

  private laserDir(out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(this.sweepPitch);
    return out.set(-Math.sin(this.sweepYaw) * c, Math.sin(this.sweepPitch), -Math.cos(this.sweepYaw) * c);
  }

  private turnTo(want: number, dt: number): void {
    this.heading += THREE.MathUtils.clamp(angleDiff(want, this.heading), -TURN * dt, TURN * dt);
  }

  private steer(speed: number, dt: number): void {
    const wp = this.follower.current(this.pos, 1.6);
    if (!wp) return;
    const want = Math.atan2(-(wp.x - this.pos.x), -(wp.z - this.pos.z));
    this.turnTo(want, dt);
    // Slow down for sharp turns so the legs keep up
    const k = Math.max(0.2, Math.cos(angleDiff(want, this.heading)));
    this.desired.set(-Math.sin(this.heading), 0, -Math.cos(this.heading)).multiplyScalar(speed * k * this.speedMult);
  }

  fixedStep(dt: number): void {
    if (!this.health.alive) return;
    const busy = this.attack !== 'none';
    const target = busy ? new THREE.Vector3() : this.desired;
    this.vel.lerp(target, Math.min(1, dt * 3));
    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    if (this.ctx.nav.walkable(nx, nz)) {
      this.pos.x = nx;
      this.pos.z = nz;
    } else {
      this.vel.multiplyScalar(0.5);
    }
    const gy = groundY(this.ctx, this, this.pos.x, this.pos.y + 0.5, this.pos.z);
    this.pos.y += (gy - this.pos.y) * Math.min(1, dt * 10);
    this._body.setNextKinematicTranslation(this.pos);
    this._body.setNextKinematicRotation(this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.heading));
  }

  // ---------------------------------------------------------------- visuals

  render(dt: number): void {
    const m = this.model;
    const alive = this.health.alive;
    const stunned = this.stunT > 0;
    // Body height from planted feet; crippled walkers sag
    const n = this.legsAlive;
    const sag = n >= 3 ? 0 : n === 2 ? 0.35 : 1.1;
    const targetY = alive ? Math.max(this.legs.meanFootY(), this.pos.y - 1) + BODY_H - sag - (this.attack === 'stomp' ? -0.4 * Math.sin(Math.min(1, this.attackT / STOMP_WINDUP) * Math.PI * 0.5) : 0) : this.pos.y + 0.9;
    this.bodyY += (targetY - this.bodyY) * Math.min(1, dt * (alive ? 6 : 2.5));
    if (!alive) this.bodyY = Math.max(this.bodyY, this.pos.y + 0.9);

    // Tilt from foot heights (front/back, left/right) + toward missing legs
    const f = this.legs.feet;
    const pitch = Math.atan2((f[2].y + f[3].y - f[0].y - f[1].y) / 2, 3.4) * 0.7;
    const roll = Math.atan2((f[0].y + f[2].y - f[1].y - f[3].y) / 2, 3.8) * 0.7;
    let lean = 0;
    let leanX = 0;
    this.legs.alive.forEach((a, i) => {
      if (a) return;
      lean += i < 2 ? -0.12 : 0.12;
      leanX += i % 2 === 0 ? 0.12 : -0.12;
    });
    const deadTilt = alive ? 0 : 0.25;
    this.tilt.set(pitch + lean + deadTilt, this.heading, roll + leanX, 'YXZ');
    m.hull.position.set(this.pos.x, this.bodyY, this.pos.z);
    m.hull.quaternion.setFromEuler(this.tilt);
    m.hull.updateMatrixWorld();

    for (let i = 0; i < 4; i++) this.hips[i].copy(m.hips[i]).applyMatrix4(m.hull.matrixWorld);
    if (alive && !stunned) {
      this.legs.update(dt, this.pos, this.heading, this.vel, this.hips, 1);
    } else if (!alive) {
      // Legs splay out under the collapsed hull
      this.legs.update(dt, this.pos, this.heading, new THREE.Vector3(), this.hips, 0);
    }
    for (let i = 0; i < 4; i++) {
      const lp = m.legs[i];
      placeBetween(lp.upper, this.hips[i], this.legs.knees[i]);
      placeBetween(lp.lower, this.legs.knees[i], this.legs.feet[i]);
      lp.lower.scale.x = lp.lower.scale.z = 1;
      lp.knee.position.copy(this.legs.knees[i]);
      lp.foot.position.copy(this.legs.feet[i]);
      if (this.legs.alive[i]) lp.kneeMat.emissiveIntensity = alive ? 1.2 + Math.sin(this.ctx.time * 5 + i) * 0.4 : 0;
      // Knee colliders follow the animated joints (body-local, yaw only)
      const local = this.legs.knees[i].clone().sub(this.pos).applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.heading);
      this.kneeCols[i].setTranslationWrtParent(local);
    }
    this.hullCol.setTranslationWrtParent({ x: 0, y: this.bodyY - this.pos.y, z: 0 });

    // Laser telegraph (thin, pulsing) → beam (thick)
    const showBeam = alive && !stunned && (this.attack === 'charge' || this.attack === 'fire');
    m.laser.visible = showBeam;
    if (showBeam) {
      const muzzle = this.muzzleWorld(new THREE.Vector3());
      if (this.attack === 'charge') {
        const dir = this.laserDir(new THREE.Vector3());
        const hit = this.ctx.physics.raycast(muzzle, dir, LASER_RANGE, undefined, this._body);
        this.beamEnd.copy(hit ? hit.point : muzzle.clone().addScaledVector(dir, LASER_RANGE));
      }
      placeBetween(m.laser, muzzle, this.beamEnd);
      const w = this.attack === 'charge' ? 0.4 + 0.3 * Math.sin(this.attackT * 40) : 3 + Math.sin(this.ctx.time * 60) * 0.6;
      m.laser.scale.x = m.laser.scale.z = w;
      m.laserMat.opacity = this.attack === 'charge' ? 0.5 + this.attackT / CHARGE_T * 0.4 : 0.95;
      m.laserMat.color.set(this.attack === 'charge' ? '#ff2010' : '#ff7050');
    }
    m.eyeMat.emissiveIntensity = !alive ? 0 : stunned ? (Math.random() < 0.3 ? 3 : 0.2) : this.attack === 'charge' ? 3 + this.attackT * 5 : this.perception.alerted ? 3 : 1.6;
    this.updateFlash(dt);
  }

  protected onDeath(): void {
    this.attack = 'none';
    this.model.laser.visible = false;
    this.ctx.effects.explosion(new THREE.Vector3(this.pos.x, this.bodyY, this.pos.z), 0.8);
    Sfx.explosion(this.pos, 0.8);
  }
}

function angleDiff(a: number, b: number): number {
  const d = a - b;
  return Math.atan2(Math.sin(d), Math.cos(d));
}
