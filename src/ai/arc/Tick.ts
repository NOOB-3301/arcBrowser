import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { RAPIER as R, Groups, interactionGroups } from '../../physics/Physics';
import { Bot } from '../Bot';
import type { AIContext } from '../AIContext';
import type { HitZone } from '../../combat/Damage';
import { PathFollower } from '../PathFollower';
import { tickModel, type TickModel } from './ArcModels';
import { groundY } from './ArcWeapons';
import { explode } from '../../combat/Explosions';
import { Sfx } from '../../audio/Sfx';

const BODY: HitZone = { kind: 'body', multiplier: 1 };
const CORE: HitZone = { kind: 'weakpoint', multiplier: 2.5 };
const CHASE_SPEED = 7.2;
const WANDER_SPEED = 1.6;
const ARM_TIME = 0.55;
const TRIGGER_DIST = 2.3;

type State = 'dormant' | 'wander' | 'hunt' | 'arming';

/** Fast suicide crawler. Packs sit dormant, wake on noise/sight, rush and detonate. */
export class Tick extends Bot {
  readonly kind = 'tick' as const;
  private _body: RAPIER.RigidBody;
  private coreCol: RAPIER.Collider;
  private model: TickModel;
  private state: State;
  private follower = new PathFollower();
  private heading = Math.random() * Math.PI * 2;
  private speed = 0;
  private desired = new THREE.Vector3();
  private armT = 0;
  private legPhase = Math.random() * 10;
  private wanderT = 0;
  private chitterT = Math.random() * 3;
  private home: THREE.Vector3;

  constructor(ctx: AIContext, pos: THREE.Vector3, dormant = true) {
    super(ctx, 'arc', 'arc', 'machine', 40);
    this.pos.copy(pos);
    this.home = pos.clone();
    this.state = dormant ? 'dormant' : 'wander';
    this._body = ctx.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z));
    const g = interactionGroups(Groups.BOT, 0xffff);
    const bodyCol = ctx.physics.world.createCollider(R.ColliderDesc.ball(0.38).setTranslation(0, 0.32, 0).setCollisionGroups(g), this._body);
    this.coreCol = ctx.physics.world.createCollider(R.ColliderDesc.ball(0.14).setTranslation(0, 0.52, 0.15).setCollisionGroups(g), this._body);
    ctx.registry.register(this, bodyCol, this.coreCol);
    this.model = tickModel();
    this.flashMats = this.model.mats;
    this.group.add(this.model.root);
    this.perception.opts.range *= 0.6;
    this.perception.opts.fovDeg = 160;
  }

  get body(): RAPIER.RigidBody {
    return this._body;
  }

  zoneFor(c: RAPIER.Collider): HitZone {
    return c.handle === this.coreCol.handle ? CORE : BODY;
  }

  aimPoints(out: THREE.Vector3[]): void {
    if (this.health.alive) out.push(this.aimPts[0].copy(this.pos).add(new THREE.Vector3(0, 0.35, 0)));
  }

  eye(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pos).add(new THREE.Vector3(0, 0.45, 0));
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
  }

  think(dt: number): void {
    if (!this.health.alive) return;
    const ctx = this.ctx;
    const eye = this.eye(new THREE.Vector3());
    this.perception.update(ctx, dt, eye, this.forward(new THREE.Vector3()));
    const tp = this.perception.targetPos();
    this.desired.set(0, 0, 0);

    if (this.state === 'arming') {
      this.armT += dt;
      if (this.armT >= ARM_TIME) this.detonate();
      return;
    }

    if (tp) {
      if (this.state === 'dormant') Sfx.chitter(this.pos);
      this.state = 'hunt';
      const d = Math.hypot(tp.x - this.pos.x, tp.z - this.pos.z);
      if (d < TRIGGER_DIST && Math.abs(tp.y - this.pos.y) < 2.5) {
        this.state = 'arming';
        this.armT = 0;
        return;
      }
      this.follower.setGoal(ctx.nav, this.pos, tp, ctx.time);
      this.steer(CHASE_SPEED);
    } else if (this.perception.investigate && ctx.time - this.perception.investigateAt < 12) {
      if (this.state === 'dormant') this.state = 'wander';
      this.follower.setGoal(ctx.nav, this.pos, this.perception.investigate, ctx.time);
      if (this.follower.done) this.perception.investigate = null;
      this.steer(CHASE_SPEED * 0.6);
    } else if (this.state === 'wander') {
      this.wanderT -= dt;
      if (this.wanderT <= 0 || this.follower.done) {
        this.wanderT = 3 + Math.random() * 4;
        const a = Math.random() * Math.PI * 2;
        const goal = this.home.clone().add(new THREE.Vector3(Math.cos(a) * 8, 0, Math.sin(a) * 8));
        this.follower.setGoal(ctx.nav, this.pos, goal, ctx.time, true);
      }
      this.steer(WANDER_SPEED);
    }
  }

  private steer(speed: number): void {
    const wp = this.follower.current(this.pos, 1.0);
    if (!wp) {
      this.speed = 0;
      return;
    }
    const dx = wp.x - this.pos.x;
    const dz = wp.z - this.pos.z;
    const want = Math.atan2(-dx, -dz);
    let dh = want - this.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    this.heading += THREE.MathUtils.clamp(dh, -0.25, 0.25);
    this.desired.set(-Math.sin(this.heading), 0, -Math.cos(this.heading)).multiplyScalar(speed);
    this.speed = speed;
  }

  fixedStep(dt: number): void {
    if (!this.health.alive) return;
    if (this.state === 'arming') this.desired.set(0, 0, 0);
    const nx = this.pos.x + this.desired.x * dt;
    const nz = this.pos.z + this.desired.z * dt;
    if (this.ctx.nav.walkable(nx, nz) || this.desired.lengthSq() === 0) {
      this.pos.x = nx;
      this.pos.z = nz;
    }
    const gy = groundY(this.ctx, this, this.pos.x, this.pos.y, this.pos.z);
    this.pos.y += (gy - this.pos.y) * Math.min(1, dt * 20);
    this._body.setNextKinematicTranslation(this.pos);
  }

  render(dt: number): void {
    const m = this.model;
    m.root.position.copy(this.pos);
    m.root.rotation.y = this.heading;
    this.updateFlash(dt);
    if (!this.health.alive) {
      m.root.rotation.z = Math.min(m.root.rotation.z + dt * 6, Math.PI);
      m.coreMat.emissiveIntensity = 0;
      return;
    }
    this.legPhase += dt * (this.speed > 0.1 ? this.speed * 3 : 0.5);
    m.legs.forEach((leg, i) => {
      leg.rotation.x = Math.sin(this.legPhase + (i % 2) * Math.PI) * (this.speed > 0.1 ? 0.45 : 0.05);
    });
    const dormant = this.state === 'dormant';
    m.root.position.y -= dormant ? 0.15 : 0;
    if (this.state === 'arming') {
      const blink = Math.sin(this.armT * 40) > 0;
      m.coreMat.emissiveIntensity = blink ? 6 : 0.5;
      m.root.scale.setScalar(1 + this.armT * 0.4);
    } else {
      m.coreMat.emissiveIntensity = dormant ? 0.4 : 1.8 + Math.sin(this.ctx.time * 6) * 0.6;
    }
    this.chitterT -= dt;
    if (this.chitterT <= 0 && this.state === 'hunt') {
      this.chitterT = 0.6 + Math.random();
      Sfx.chitter(this.pos);
    }
  }

  private detonate(): void {
    if (!this.health.alive) return;
    this.health.alive = false;
    this.health.hp = 0;
    this.disableColliders();
    const ctx = this.ctx;
    explode(ctx.physics, ctx.registry, ctx.effects, this.pos.clone().add(new THREE.Vector3(0, 0.4, 0)), {
      radius: 4.5, damage: 70 * ctx.difficulty.damageMult, faction: 'arc', team: 'arc', size: 1, excludeBody: this._body, attacker: this,
    });
    this.model.root.visible = false;
    this.deadT = 0;
  }

  protected onDeath(): void {
    this.ctx.effects.impact(this.pos.clone().add(new THREE.Vector3(0, 0.4, 0)), new THREE.Vector3(0, 1, 0), 'machine', false);
  }
}
