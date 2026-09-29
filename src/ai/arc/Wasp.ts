import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { RAPIER as R, Groups, interactionGroups } from '../../physics/Physics';
import { Bot } from '../Bot';
import type { AIContext } from '../AIContext';
import type { HitZone } from '../../combat/Damage';
import { AimModel } from '../AimModel';
import { waspModel, type WaspModel } from './ArcModels';
import { arcBolt } from './ArcWeapons';
import { explode } from '../../combat/Explosions';

const BODY: HitZone = { kind: 'body', multiplier: 1, armor: 0.2 };
const ROTOR: HitZone = { kind: 'weakpoint', multiplier: 2.2 };
const MAX_SPEED = 11;
const ACCEL = 9;
const CRUISE_ALT = 14;
const BOLT_SPEED = 170;
const BOLT_DAMAGE = 9;

/**
 * Strike drone: patrols a loop at altitude, orbits and strafes targets with
 * short bolt bursts. Shoot the rotor hubs.
 */
export class Wasp extends Bot {
  readonly kind = 'wasp' as const;
  private _body: RAPIER.RigidBody;
  private rotorCols: number[] = [];
  private model: WaspModel;
  private vel = new THREE.Vector3();
  private yaw = 0;
  private route: THREE.Vector3[];
  private routeI = 0;
  private orbitA = Math.random() * Math.PI * 2;
  private orbitDir = Math.random() < 0.5 ? 1 : -1;
  private burstLeft = 0;
  private shotT = 0;
  private cooldown = 1.5;
  private aim = new AimModel();
  private falling = false;
  private spin = 0;

  constructor(ctx: AIContext, pos: THREE.Vector3, route: THREE.Vector3[]) {
    super(ctx, 'arc', 'arc', 'machine', 90);
    this.pos.copy(pos);
    this.route = route.length ? route : [pos.clone()];
    this._body = ctx.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z));
    const g = interactionGroups(Groups.BOT, 0xffff);
    const cols = [ctx.physics.world.createCollider(R.ColliderDesc.ball(0.5).setCollisionGroups(g), this._body)];
    for (const [x, z] of [[-0.75, -0.6], [0.75, -0.6], [0.75, 0.6], [-0.75, 0.6]]) {
      const c = ctx.physics.world.createCollider(R.ColliderDesc.ball(0.22).setTranslation(x, 0.15, z).setCollisionGroups(g), this._body);
      this.rotorCols.push(c.handle);
      cols.push(c);
    }
    ctx.registry.register(this, ...cols);
    this.model = waspModel();
    this.flashMats = this.model.mats;
    this.group.add(this.model.root);
    this.perception.opts.fovDeg = 200; // looks down and around
    this.perception.opts.range *= 1.1;
  }

  get body(): RAPIER.RigidBody {
    return this._body;
  }

  zoneFor(c: RAPIER.Collider): HitZone {
    return this.rotorCols.includes(c.handle) ? ROTOR : BODY;
  }

  aimPoints(out: THREE.Vector3[]): void {
    if (this.health.alive) out.push(this.aimPts[0].copy(this.pos));
  }

  eye(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pos).add(new THREE.Vector3(0, -0.2, 0));
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), -0.35, -Math.cos(this.yaw)).normalize();
  }

  private ground(x: number, z: number): number {
    return Math.max(this.ctx.heightAt(x, z), this.ctx.nav.floorAt(x, z));
  }

  think(dt: number): void {
    if (!this.health.alive) return;
    const ctx = this.ctx;
    const d = ctx.difficulty;
    const eye = this.eye(new THREE.Vector3());
    this.perception.update(ctx, dt, eye, this.forward(new THREE.Vector3()));
    const target = this.perception.target;
    const tp = this.perception.targetPos();
    const visible = this.perception.targetVisible;
    this.aim.update(dt, target, visible, d);

    let goal: THREE.Vector3;
    if (tp) {
      // Orbit the target, drifting in and out
      this.orbitA += this.orbitDir * dt * 0.35;
      const r = 18 + Math.sin(ctx.time * 0.4) * 5;
      goal = new THREE.Vector3(tp.x + Math.cos(this.orbitA) * r, 0, tp.z + Math.sin(this.orbitA) * r);
      goal.y = Math.max(tp.y + 7, this.ground(goal.x, goal.z) + 5);
      this.yaw = Math.atan2(-(tp.x - this.pos.x), -(tp.z - this.pos.z));

      // Fire control
      this.cooldown -= dt;
      const reacted = ctx.time - this.perception.alertedAt > d.reactionTime;
      if (visible && reacted && this.cooldown <= 0 && this.burstLeft === 0) {
        this.burstLeft = 4 + Math.floor(Math.random() * 3);
        this.aim.newBurst(d);
        this.shotT = 0;
      }
      if (this.burstLeft > 0) {
        this.shotT -= dt;
        if (this.shotT <= 0 && visible) {
          const info = this.perception.info(target!)!;
          const muzzle = this.pos.clone().add(new THREE.Vector3(0, -0.3, 0));
          const dir = this.aim.direction(muzzle, info.lastPos, undefined, info.velocity, BOLT_SPEED, d, 1.5 + this.vel.length() * 0.15);
          arcBolt(ctx, this, muzzle, dir, BOLT_DAMAGE, BOLT_SPEED);
          this.burstLeft--;
          this.shotT = 0.11;
          if (this.burstLeft === 0) this.cooldown = 1.8 + Math.random() * 1.2;
        } else if (!visible) {
          this.burstLeft = 0;
        }
      }
    } else {
      // Patrol loop
      const wp = this.route[this.routeI];
      goal = new THREE.Vector3(wp.x, this.ground(wp.x, wp.z) + CRUISE_ALT, wp.z);
      if (Math.hypot(wp.x - this.pos.x, wp.z - this.pos.z) < 8) this.routeI = (this.routeI + 1) % this.route.length;
      if (this.perception.investigate && ctx.time - this.perception.investigateAt < 10) {
        const p = this.perception.investigate;
        goal.set(p.x, this.ground(p.x, p.z) + 9, p.z);
      }
      const v = this.vel;
      if (v.lengthSq() > 1) this.yaw = Math.atan2(-v.x, -v.z);
    }

    // Steering with terrain/obstacle avoidance
    const want = goal.sub(this.pos);
    const dist = want.length();
    want.normalize().multiplyScalar(Math.min(MAX_SPEED, dist * 0.8));
    const ahead = this.pos.clone().addScaledVector(this.vel, 1.2);
    const floorAhead = this.ground(ahead.x, ahead.z);
    if (this.pos.y < floorAhead + 5) want.y += 6;
    if (this.vel.lengthSq() > 1) {
      const dir = this.vel.clone().normalize();
      const hit = ctx.physics.raycast(this.pos, dir, 7, undefined, this._body);
      if (hit) want.y += 8;
    }
    const dv = want.sub(this.vel);
    const maxDv = ACCEL * dt;
    if (dv.length() > maxDv) dv.setLength(maxDv);
    this.vel.add(dv);
  }

  fixedStep(dt: number): void {
    if (this.falling) {
      this.vel.y -= 9.81 * dt;
      this.pos.addScaledVector(this.vel, dt);
      this.spin += dt * 8;
      const g = this.ground(this.pos.x, this.pos.z);
      if (this.pos.y <= g + 0.3) {
        this.falling = false;
        this.pos.y = g + 0.3;
        const ctx = this.ctx;
        explode(ctx.physics, ctx.registry, ctx.effects, this.pos.clone(), { radius: 3, damage: 25, faction: 'arc-wreck', team: 'arc', size: 0.7, excludeBody: this._body });
      }
      this._body.setNextKinematicTranslation(this.pos);
      return;
    }
    if (!this.health.alive) return;
    this.pos.addScaledVector(this.vel, dt);
    const floor = this.ground(this.pos.x, this.pos.z) + 2;
    if (this.pos.y < floor) this.pos.y = floor;
    this._body.setNextKinematicTranslation(this.pos);
  }

  render(dt: number): void {
    const m = this.model;
    m.root.position.copy(this.pos);
    m.root.rotation.y = this.yaw;
    // Bank into motion
    const localV = this.vel.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.yaw);
    m.body.rotation.x = THREE.MathUtils.lerp(m.body.rotation.x, -localV.z * 0.04, Math.min(1, dt * 5));
    m.body.rotation.z = THREE.MathUtils.lerp(m.body.rotation.z, localV.x * 0.05, Math.min(1, dt * 5));
    if (this.falling || !this.health.alive) {
      m.body.rotation.z += this.spin * dt;
      m.eye.emissiveIntensity = 0;
    } else {
      for (const r of m.rotors) r.rotation.y += dt * 40;
      m.eye.emissiveIntensity = this.perception.alerted ? 3 : 1.2;
    }
    this.updateFlash(dt);
  }

  protected onDeath(): void {
    this.falling = true;
    this.vel.multiplyScalar(0.5);
  }
}
