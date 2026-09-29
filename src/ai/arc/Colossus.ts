import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { RAPIER as R, Groups, interactionGroups } from '../../physics/Physics';
import { Bot } from '../Bot';
import type { AIContext } from '../AIContext';
import type { DamageResult, HitZone } from '../../combat/Damage';
import { colossusModel, placeBetween, strikeMarker, type ColossusModel } from './ArcModels2';
import { WalkerLegs } from './WalkerLegs';
import { beamDamage } from './ArcLaser';
import { explode } from '../../combat/Explosions';
import { Events } from '../../core/Events';
import { Sfx } from '../../audio/Sfx';

const HULL: HitZone = { kind: 'armor', multiplier: 0.15, armor: 0.6 };
const HEAD: HitZone = { kind: 'armor', multiplier: 0.3, armor: 0.4 };
const LEG: HitZone = { kind: 'limb', multiplier: 0.25, armor: 0.5 };
const PLATE: HitZone = { kind: 'armor', multiplier: 0.35 };
const CORE: HitZone = { kind: 'weakpoint', multiplier: 3 };
const BODY_H = 9;
const WALK_SPEED = 1.5;
const TURN = 0.3;
const PLATE_HP = 350;
const LASER_CHARGE = 1.5;
const LASER_FIRE = 2.2;
const LASER_DPS = 110;
const LASER_RANGE = 160;
const STRIKE_DELAY = 1.5;
const STRIKE_RADIUS = 5;
const STRIKE_DAMAGE = 45;
/** Explosions (applyDirect → 'body' zone) only deal this fraction to the boss. */
const BLAST_FRACTION = 0.25;

type Attack = 'none' | 'charge' | 'fire' | 'barrage' | 'stomp';

interface Strike {
  pos: THREE.Vector3;
  t: number;
  marker: THREE.Mesh;
  shell: THREE.Mesh;
}

interface Debris {
  mesh: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}

/**
 * W4 — Colossus boss. A slow 13 m siege walker roaming between waypoints.
 * Four armour plates (own HP) guard a glowing core that only takes damage once
 * they're shot off. Attacks: telegraphed artillery barrage and a heavy laser.
 * Footsteps shake the camera and are loud.
 */
export class Colossus extends Bot {
  readonly kind = 'colossus' as const;
  readonly displayName = 'COLOSSUS';
  private _body: RAPIER.RigidBody;
  private hullCol: RAPIER.Collider;
  private headCol: RAPIER.Collider;
  private coreCol: RAPIER.Collider;
  private plateCols: RAPIER.Collider[] = [];
  private legCols: RAPIER.Collider[] = [];
  readonly plateHp: number[];
  readonly plateMax: number;
  private model: ColossusModel;
  private legs: WalkerLegs;
  private heading: number;
  private headYaw = 0;
  private headPitch = 0;
  private vel = new THREE.Vector3();
  private route: THREE.Vector3[];
  private routeI = 0;
  private attack: Attack = 'none';
  private attackT = 0;
  private nextAttack: 'laser' | 'barrage' = 'barrage';
  private attackCd = 3;
  private stompCd = 0;
  private strikes: Strike[] = [];
  private debris: Debris[] = [];
  private beamEnd = new THREE.Vector3();
  private sparkT = 0;
  private lastHit: { kind: 'plate' | 'core' | 'other'; i: number } = { kind: 'other', i: -1 };
  private bodyY: number;
  private hips = [0, 1, 2, 3].map(() => new THREE.Vector3());
  private deathT = 0;
  private _q = new THREE.Quaternion();
  /** Seconds since the boss last had a target (HUD: engaged). */
  engagedT = 99;

  constructor(ctx: AIContext, pos: THREE.Vector3, route: THREE.Vector3[] = [], facing = 0) {
    super(ctx, 'arc', 'arc', 'machine', 4000);
    this.pos.copy(pos);
    this.heading = facing;
    this.bodyY = pos.y + BODY_H;
    this.route = route.length ? route.map((p) => p.clone()) : [pos.clone()];
    this.plateMax = PLATE_HP * ctx.difficulty.healthMult;
    this.plateHp = [0, 0, 0, 0].map(() => this.plateMax);
    this._body = ctx.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z));
    const g = interactionGroups(Groups.BOT, 0xffff);
    const w = ctx.physics.world;
    this.model = colossusModel();
    this.hullCol = w.createCollider(R.ColliderDesc.cuboid(3.3, 1.9, 4.3).setTranslation(0, BODY_H, 0).setCollisionGroups(g), this._body);
    this.headCol = w.createCollider(R.ColliderDesc.cuboid(1.5, 0.8, 1.5).setTranslation(0, BODY_H + 2.9, -1.8).setCollisionGroups(g), this._body);
    for (const pl of this.model.plateLayout) {
      this.plateCols.push(
        w.createCollider(R.ColliderDesc.cuboid(pl.size.x / 2, pl.size.y / 2, pl.size.z / 2 + 0.1).setTranslation(pl.pos.x, BODY_H + pl.pos.y, pl.pos.z).setCollisionGroups(g), this._body),
      );
    }
    this.coreCol = w.createCollider(R.ColliderDesc.ball(0.95).setTranslation(0, BODY_H - 0.2, -4.75).setCollisionGroups(g), this._body);
    this.coreCol.setEnabled(false);
    for (let i = 0; i < 4; i++) this.legCols.push(w.createCollider(R.ColliderDesc.ball(1.1).setTranslation(0, BODY_H, 0).setCollisionGroups(g), this._body));
    ctx.registry.register(this, this.hullCol, this.headCol, this.coreCol, ...this.plateCols, ...this.legCols);
    this.flashMats = this.model.mats;
    this.group.add(this.model.root);
    this.legs = new WalkerLegs(
      {
        rest: [new THREE.Vector3(-6.5, 0, -5.5), new THREE.Vector3(6.5, 0, -5.5), new THREE.Vector3(-6.5, 0, 5.5), new THREE.Vector3(6.5, 0, 5.5)],
        upper: 6.5,
        lower: 7.5,
        stride: 2.6,
        stepTime: 1.0,
        stepHeight: 1.6,
        groups: [[0], [3], [1], [2]],
      },
      (x, z) => ctx.heightAt(x, z),
      pos,
      facing,
    );
    this.legs.onStep = (_i, p) => this.footstep(p);
    this.perception.opts.range *= 1.6;
    this.perception.opts.fovDeg = 240;
    this.perception.opts.detect *= 1.3;
  }

  get body(): RAPIER.RigidBody {
    return this._body;
  }

  get platesLeft(): number {
    return this.plateHp.filter((h) => h > 0).length;
  }

  get coreExposed(): boolean {
    return this.platesLeft === 0;
  }

  /** Collider handles for tests/debug: plates (in order) and the core. */
  get debugColliders(): { plates: RAPIER.Collider[]; core: RAPIER.Collider; hull: RAPIER.Collider } {
    return { plates: this.plateCols, core: this.coreCol, hull: this.hullCol };
  }

  zoneFor(c: RAPIER.Collider): HitZone {
    const pi = this.plateCols.findIndex((p) => p.handle === c.handle);
    if (pi >= 0) {
      this.lastHit = { kind: 'plate', i: pi };
      return PLATE;
    }
    this.lastHit = { kind: c.handle === this.coreCol.handle ? 'core' : 'other', i: -1 };
    if (c.handle === this.coreCol.handle) return CORE;
    if (c.handle === this.headCol.handle) return HEAD;
    if (this.legCols.some((l) => l.handle === c.handle)) return LEG;
    return HULL;
  }

  aimPoints(out: THREE.Vector3[]): void {
    if (!this.health.alive) return;
    const f = this.forward(new THREE.Vector3()).setY(0).normalize();
    out.push(this.aimPts[0].set(this.pos.x, this.bodyY, this.pos.z).addScaledVector(f, 5.2));
  }

  eye(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x, this.bodyY + 3.2, this.pos.z);
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    const yaw = this.heading + this.headYaw;
    return out.set(-Math.sin(yaw), -0.25, -Math.cos(yaw)).normalize();
  }

  onDamaged(r: DamageResult): void {
    const hit = this.lastHit;
    this.lastHit = { kind: 'other', i: -1 };
    if (r.zone === PLATE && hit.kind === 'plate' && this.plateHp[hit.i] > 0) {
      this.plateHp[hit.i] -= r.dealt / PLATE.multiplier;
      if (this.plateHp[hit.i] <= 0) this.breakPlate(hit.i);
    } else if (r.zone.kind === 'body' && r.zone !== HULL && this.health.alive) {
      // Area damage (explosions) bypasses zones: refund most of it
      this.health.hp = Math.min(this.health.maxHp, this.health.hp + r.toHp * (1 - BLAST_FRACTION));
    }
    this.engagedT = 0;
    super.onDamaged(r);
  }

  private breakPlate(i: number): void {
    this.plateHp[i] = 0;
    this.plateCols[i].setEnabled(false);
    const m = this.model.plates[i];
    const wp = new THREE.Vector3();
    m.getWorldPosition(wp);
    const wq = new THREE.Quaternion();
    m.getWorldQuaternion(wq);
    this.ctx.scene.add(m);
    m.position.copy(wp);
    m.quaternion.copy(wq);
    const f = this.forward(new THREE.Vector3()).setY(0).normalize();
    this.debris.push({ mesh: m, vel: f.multiplyScalar(6).add(new THREE.Vector3((Math.random() - 0.5) * 4, 5, 0)), spin: new THREE.Vector3(Math.random() * 4, Math.random() * 4, Math.random() * 4), life: 4 });
    this.ctx.effects.explosion(wp, 0.5);
    Sfx.explosion(wp, 0.6);
    if (this.coreExposed) {
      this.coreCol.setEnabled(true);
      Events.emit('toast', 'Colossus core exposed!');
    } else {
      Events.emit('toast', `Colossus plate destroyed (${this.platesLeft} left)`);
    }
  }

  private footstep(p: THREE.Vector3): void {
    if (!this.health.alive) return;
    Events.emit('explosion', { pos: p.clone(), radius: 4.5, size: 0 });
    Events.emit('noise', { emitter: this, pos: p.clone(), radius: 90, source: 'footstep' });
    Sfx.stomp(p, 2.2);
    if (this.focusDist < 150) {
      for (let k = 0; k < 4; k++) {
        const a = Math.random() * Math.PI * 2;
        this.ctx.effects.impact(p.clone().add(new THREE.Vector3(Math.cos(a) * 1.5, 0.2, Math.sin(a) * 1.5)), new THREE.Vector3(Math.cos(a), 1, Math.sin(a)).normalize(), 'dirt', false);
      }
    }
  }

  // ---------------------------------------------------------------- AI

  think(dt: number): void {
    if (!this.health.alive) return;
    const ctx = this.ctx;
    const eye = this.eye(new THREE.Vector3());
    this.perception.update(ctx, dt, eye, this.forward(new THREE.Vector3()));
    const tp = this.perception.targetPos();
    const visible = this.perception.targetVisible;
    this.attackCd -= dt;
    this.stompCd -= dt;
    this.engagedT = tp ? 0 : this.engagedT + dt;

    // Turret tracks the target (or the investigate point)
    const look = tp ?? (this.perception.investigate && ctx.time - this.perception.investigateAt < 10 ? this.perception.investigate : null);
    let wantHead = 0;
    let wantPitch = 0;
    const muzzle = this.muzzleWorld(new THREE.Vector3());
    if (look) {
      wantHead = angleDiff(Math.atan2(-(look.x - this.pos.x), -(look.z - this.pos.z)), this.heading);
      wantHead = THREE.MathUtils.clamp(wantHead, -2.2, 2.2);
      wantPitch = Math.atan2(look.y - muzzle.y, Math.hypot(look.x - muzzle.x, look.z - muzzle.z));
    }
    const turretRate = this.attack === 'fire' ? 0.28 : 0.7;
    this.headYaw += THREE.MathUtils.clamp(wantHead - this.headYaw, -turretRate * dt, turretRate * dt);
    this.headPitch += THREE.MathUtils.clamp(wantPitch - this.headPitch, -turretRate * dt, turretRate * dt);

    // Attacks
    if (this.attack !== 'none') this.runAttack(dt, tp);
    else if (tp) {
      const dist = Math.hypot(tp.x - this.pos.x, tp.z - this.pos.z);
      const reacted = ctx.time - this.perception.alertedAt > ctx.difficulty.reactionTime + 0.5;
      if (dist < 9 && this.stompCd <= 0) {
        this.attack = 'stomp';
        this.attackT = 0;
      } else if (this.attackCd <= 0 && reacted) {
        const laser = this.nextAttack === 'laser' && visible && dist < LASER_RANGE * 0.8;
        if (laser) {
          this.attack = 'charge';
          Sfx.laserCharge(this.pos, LASER_CHARGE);
        } else {
          this.attack = 'barrage';
          this.launchBarrage(tp);
        }
        this.attackT = 0;
        this.nextAttack = this.nextAttack === 'laser' ? 'barrage' : 'laser';
      }
    }

    // Roam between waypoints (slower while firing)
    const wp = this.route[this.routeI];
    const dx = wp.x - this.pos.x;
    const dz = wp.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 6) this.routeI = (this.routeI + 1) % this.route.length;
    let speed = d > 3 ? WALK_SPEED : 0;
    if (this.attack === 'fire' || this.attack === 'charge') speed *= 0.3;
    if (this.attack === 'stomp') speed = 0;
    const want = Math.atan2(-dx, -dz);
    this.heading += THREE.MathUtils.clamp(angleDiff(want, this.heading), -TURN * dt, TURN * dt);
    const k = Math.max(0.15, Math.cos(angleDiff(want, this.heading)));
    this.vel.set(-Math.sin(this.heading), 0, -Math.cos(this.heading)).multiplyScalar(speed * k);
  }

  private launchBarrage(tp: THREE.Vector3): void {
    const ctx = this.ctx;
    const n = 6;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = i === 0 ? 0 : 3 + Math.random() * 8;
      const x = tp.x + Math.cos(a) * r;
      const z = tp.z + Math.sin(a) * r;
      const hit = ctx.physics.raycast(new THREE.Vector3(x, tp.y + 3, z), new THREE.Vector3(0, -1, 0), 30, undefined, this._body);
      const y = hit ? hit.point.y : ctx.heightAt(x, z);
      const pos = new THREE.Vector3(x, y, z);
      const marker = strikeMarker(STRIKE_RADIUS);
      marker.position.copy(pos).add(new THREE.Vector3(0, 0.12, 0));
      ctx.scene.add(marker);
      const shell = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffb060' }));
      shell.visible = false;
      ctx.scene.add(shell);
      this.strikes.push({ pos, t: -(STRIKE_DELAY + i * 0.15), marker, shell });
    }
    this.model.hull.updateMatrixWorld();
    for (const t of this.model.tubes) {
      const p = t.clone().applyMatrix4(this.model.hull.matrixWorld);
      ctx.effects.muzzleFlash(p, 0xff8040, 3);
      ctx.effects.impact(p, new THREE.Vector3(0, 1, 0), 'metal', false);
    }
    Sfx.mortar(this.pos);
    Events.emit('noise', { emitter: this, pos: this.pos.clone(), radius: 140, source: 'gunshot' });
  }

  private runAttack(dt: number, tp: THREE.Vector3 | null): void {
    const ctx = this.ctx;
    this.attackT += dt;
    if (this.attack === 'charge') {
      if (this.attackT >= LASER_CHARGE) {
        this.attack = 'fire';
        this.attackT = 0;
        Sfx.laserFire(this.pos, LASER_FIRE);
      }
    } else if (this.attack === 'fire') {
      const muzzle = this.muzzleWorld(new THREE.Vector3());
      const dir = this.laserDir(new THREE.Vector3());
      const r = beamDamage(ctx, this, muzzle, dir, LASER_RANGE, 1.3, LASER_DPS * ctx.difficulty.damageMult * dt, this.beamEnd);
      this.sparkT -= dt;
      if (this.sparkT <= 0 && r.normal) {
        this.sparkT = 0.04;
        ctx.effects.impact(this.beamEnd.clone(), r.normal, 'metal', true);
      }
      if (this.attackT >= LASER_FIRE) this.endAttack(5);
    } else if (this.attack === 'barrage') {
      if (this.attackT > 2.5) this.endAttack(6);
    } else if (this.attack === 'stomp') {
      if (this.attackT >= 0.8) {
        const p = this.pos.clone().add(new THREE.Vector3(0, 0.6, 0));
        explode(ctx.physics, ctx.registry, ctx.effects, p, { radius: 9, damage: 60 * ctx.difficulty.damageMult, faction: 'arc', team: 'arc', size: 1.6, excludeBody: this._body, attacker: this });
        Sfx.stomp(p, 3);
        this.stompCd = 5;
        this.attack = 'none';
      }
    }
    void tp;
  }

  private endAttack(cd: number): void {
    this.attack = 'none';
    this.attackCd = cd + Math.random() * 2;
  }

  /** Artillery shells fly independently of the current attack state. */
  private updateStrikes(dt: number): void {
    const ctx = this.ctx;
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.t += dt;
      const k = Math.min(1, (s.t + STRIKE_DELAY + 0.5) / 0.3);
      const pulse = 0.55 + 0.45 * Math.sin(ctx.time * (8 + (s.t + STRIKE_DELAY) * 10));
      (s.marker.material as THREE.MeshBasicMaterial).opacity = pulse;
      s.marker.scale.setScalar(0.4 + 0.6 * k);
      if (s.t > -0.5 && s.t < 0) {
        s.shell.visible = true;
        s.shell.position.copy(s.pos).add(new THREE.Vector3(0, -s.t * 110, 0));
        if (!s.shell.userData.whistled) {
          s.shell.userData.whistled = true;
          Sfx.incoming(s.pos);
        }
      }
      if (s.t >= 0) {
        explode(ctx.physics, ctx.registry, ctx.effects, s.pos.clone().add(new THREE.Vector3(0, 0.3, 0)), {
          radius: STRIKE_RADIUS, damage: STRIKE_DAMAGE * ctx.difficulty.damageMult, faction: 'arc', team: 'arc', size: 1.1, excludeBody: this._body, attacker: this,
        });
        this.removeStrike(i);
      }
    }
  }

  private removeStrike(i: number): void {
    const s = this.strikes[i];
    this.ctx.scene.remove(s.marker, s.shell);
    s.marker.geometry.dispose();
    s.shell.geometry.dispose();
    this.strikes.splice(i, 1);
  }

  private muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.model.head.updateMatrixWorld();
    return out.copy(this.model.muzzle).applyMatrix4(this.model.head.matrixWorld);
  }

  private laserDir(out: THREE.Vector3): THREE.Vector3 {
    const yaw = this.heading + this.headYaw;
    const c = Math.cos(this.headPitch);
    return out.set(-Math.sin(yaw) * c, Math.sin(this.headPitch), -Math.cos(yaw) * c);
  }

  fixedStep(dt: number): void {
    if (!this.health.alive) return;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y = this.ctx.heightAt(this.pos.x, this.pos.z);
    this._body.setNextKinematicTranslation(this.pos);
    this._body.setNextKinematicRotation(this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.heading));
  }

  // ---------------------------------------------------------------- visuals

  render(dt: number): void {
    const m = this.model;
    const alive = this.health.alive;
    const stunned = this.stunT > 0;
    this.updateStrikes(dt);
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      d.vel.y -= 9.81 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      const g = this.ctx.heightAt(d.mesh.position.x, d.mesh.position.z) + 0.2;
      if (d.mesh.position.y < g) {
        d.mesh.position.y = g;
        d.vel.set(0, 0, 0);
        d.spin.set(0, 0, 0);
      }
      if (d.life <= 0) this.debris.splice(i, 1);
    }

    let targetY = this.legs.meanFootY() + BODY_H;
    if (this.attack === 'stomp') targetY += Math.sin(Math.min(1, this.attackT / 0.8) * Math.PI * 0.5) * 1.2;
    if (!alive) {
      this.deathT += dt;
      targetY = this.pos.y + 3;
      if (this.deathT < 2.5 && Math.random() < dt * 5) {
        const p = new THREE.Vector3(this.pos.x + (Math.random() - 0.5) * 6, this.bodyY + (Math.random() - 0.5) * 3, this.pos.z + (Math.random() - 0.5) * 8);
        this.ctx.effects.explosion(p, 0.8);
        Sfx.explosion(p, 0.8);
      }
    }
    this.bodyY += (targetY - this.bodyY) * Math.min(1, dt * (alive ? 3 : 0.8));
    const f = this.legs.feet;
    const pitch = alive ? Math.atan2((f[2].y + f[3].y - f[0].y - f[1].y) / 2, 11) * 0.6 : Math.min(0.3, this.deathT * 0.15);
    const roll = alive ? Math.atan2((f[0].y + f[2].y - f[1].y - f[3].y) / 2, 13) * 0.6 : Math.min(0.2, this.deathT * 0.1);
    const sway = alive ? Math.sin(this.ctx.time * 1.6) * 0.015 * (this.vel.lengthSq() > 0.1 ? 1 : 0) : 0;
    m.hull.position.set(this.pos.x, this.bodyY, this.pos.z);
    m.hull.quaternion.setFromEuler(new THREE.Euler(pitch, this.heading, roll + sway, 'YXZ'));
    m.head.rotation.set(this.headPitch * 0.5, this.headYaw, 0, 'YXZ');
    m.hull.updateMatrixWorld();
    for (let i = 0; i < 4; i++) this.hips[i].copy(m.hips[i]).applyMatrix4(m.hull.matrixWorld);
    if (alive && !stunned) this.legs.update(dt, this.pos, this.heading, this.vel, this.hips);
    else this.legs.update(dt, this.pos, this.heading, new THREE.Vector3(), this.hips, 0);
    for (let i = 0; i < 4; i++) {
      const lp = m.legs[i];
      placeBetween(lp.upper, this.hips[i], this.legs.knees[i]);
      placeBetween(lp.lower, this.legs.knees[i], this.legs.feet[i]);
      lp.knee.position.copy(this.legs.knees[i]);
      lp.foot.position.copy(this.legs.feet[i]);
      lp.kneeMat.emissiveIntensity = alive ? 1.2 : 0;
      const local = this.legs.knees[i].clone().sub(this.pos).applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.heading);
      this.legCols[i].setTranslationWrtParent(local);
    }
    const lift = this.bodyY - this.pos.y;
    this.hullCol.setTranslationWrtParent({ x: 0, y: lift, z: 0 });
    this.headCol.setTranslationWrtParent({ x: 0, y: lift + 2.9, z: -1.8 });
    this.coreCol.setTranslationWrtParent({ x: 0, y: lift - 0.2, z: -4.75 });
    this.model.plateLayout.forEach((pl, i) => this.plateCols[i].setTranslationWrtParent({ x: pl.pos.x, y: lift + pl.pos.y, z: pl.pos.z }));

    // Core: dim behind plates, blazing when exposed
    m.coreMat.emissiveIntensity = !alive ? 0 : this.coreExposed ? 4 + Math.sin(this.ctx.time * 8) * 2 : 1.2 + (4 - this.platesLeft) * 0.5;
    m.eyeMat.emissiveIntensity = !alive ? 0 : stunned ? (Math.random() < 0.3 ? 4 : 0.2) : this.attack === 'charge' ? 3 + this.attackT * 4 : this.perception.alerted ? 3 : 1.5;

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
      const w = this.attack === 'charge' ? 0.15 + (this.attackT / LASER_CHARGE) * 0.25 : 1 + Math.sin(this.ctx.time * 50) * 0.2;
      m.laser.scale.x = m.laser.scale.z = w;
      m.laserMat.opacity = this.attack === 'charge' ? 0.4 + 0.3 * Math.sin(this.attackT * 30) : 0.95;
    }
    this.updateFlash(dt);
  }

  protected onDeath(): void {
    this.attack = 'none';
    this.model.laser.visible = false;
    for (let i = this.strikes.length - 1; i >= 0; i--) this.removeStrike(i);
    const pos = new THREE.Vector3(this.pos.x, this.bodyY, this.pos.z);
    this.ctx.effects.explosion(pos, 2.5);
    Sfx.explosion(pos, 2.5);
    Events.emit('explosion', { pos: pos.clone(), radius: 12, size: 2.5 });
    Events.emit('arc:bossKilled', { pos: this.pos.clone(), kind: 'colossus' });
    Events.emit('arc:drop', { kind: 'colossus', pos: this.pos.clone() });
    Events.emit('toast', 'COLOSSUS DESTROYED');
  }

  dispose(): void {
    for (let i = this.strikes.length - 1; i >= 0; i--) this.removeStrike(i);
    for (const d of this.debris) this.ctx.scene.remove(d.mesh);
    for (const p of this.model.plates) this.ctx.scene.remove(p);
    super.dispose();
  }
}

function angleDiff(a: number, b: number): number {
  const d = a - b;
  return Math.atan2(Math.sin(d), Math.cos(d));
}
