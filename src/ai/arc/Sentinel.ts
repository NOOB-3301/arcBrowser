import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { RAPIER as R, Groups, interactionGroups } from '../../physics/Physics';
import { Bot } from '../Bot';
import type { AIContext } from '../AIContext';
import type { HitZone } from '../../combat/Damage';
import { AimModel } from '../AimModel';
import { sentinelModel, type SentinelModel } from './ArcModels';
import { arcBolt } from './ArcWeapons';
import { Events } from '../../core/Events';
import { Sfx } from '../../audio/Sfx';

const BASE: HitZone = { kind: 'body', multiplier: 0.8, armor: 0.5 };
const HEAD: HitZone = { kind: 'armor', multiplier: 1, armor: 0.6 };
const EYE: HitZone = { kind: 'weakpoint', multiplier: 2.5 };
const SCAN_ARC = THREE.MathUtils.degToRad(65);
const TURN = 1.7; // rad/s
const BOLT_SPEED = 280;
const BOLT_DAMAGE = 12;

/**
 * Static turret. Sweeps a laser; locks on (laser turns red + beeps), then
 * fires heavy bursts and raises the alarm for nearby ARC.
 */
export class Sentinel extends Bot {
  readonly kind = 'sentinel' as const;
  private _body: RAPIER.RigidBody;
  private headCol: RAPIER.Collider;
  private eyeCol: RAPIER.Collider;
  private model: SentinelModel;
  private headYaw: number;
  private headPitch = 0;
  private scanDir = 1;
  private lockT = 0;
  private burstLeft = 0;
  private shotT = 0;
  private cooldown = 0;
  private alarmed = false;
  private beepT = 0;
  private aim = new AimModel();
  private laserEnd = new THREE.Vector3();

  constructor(ctx: AIContext, pos: THREE.Vector3, private facing: number) {
    super(ctx, 'arc', 'arc', 'machine', 260);
    this.pos.copy(pos);
    this.headYaw = facing;
    this._body = ctx.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z));
    const g = interactionGroups(Groups.BOT, 0xffff);
    const base = ctx.physics.world.createCollider(R.ColliderDesc.cylinder(0.9, 0.5).setTranslation(0, 0.9, 0).setCollisionGroups(g), this._body);
    this.headCol = ctx.physics.world.createCollider(R.ColliderDesc.cuboid(0.45, 0.3, 0.42).setTranslation(0, 2.05, 0).setCollisionGroups(g), this._body);
    this.eyeCol = ctx.physics.world.createCollider(R.ColliderDesc.ball(0.15).setTranslation(0, 2.13, -0.45).setCollisionGroups(g), this._body);
    ctx.registry.register(this, base, this.headCol, this.eyeCol);
    this.model = sentinelModel();
    this.flashMats = this.model.mats;
    this.group.add(this.model.root);
    this.model.root.position.copy(pos);
    this.perception.opts.range *= 1.25;
    this.perception.opts.fovDeg = 45;
    this.perception.opts.detect *= 1.4;
  }

  get body(): RAPIER.RigidBody {
    return this._body;
  }

  zoneFor(c: RAPIER.Collider): HitZone {
    if (c.handle === this.eyeCol.handle) return EYE;
    if (c.handle === this.headCol.handle) return HEAD;
    return BASE;
  }

  aimPoints(out: THREE.Vector3[]): void {
    if (this.health.alive) out.push(this.aimPts[0].copy(this.pos).add(new THREE.Vector3(0, 2.05, 0)));
  }

  eye(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.pos).add(new THREE.Vector3(0, 2.13, 0));
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(this.headPitch);
    return out.set(-Math.sin(this.headYaw) * c, Math.sin(this.headPitch), -Math.cos(this.headYaw) * c);
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

    let wantYaw = this.headYaw;
    let wantPitch = 0;
    if (tp) {
      const to = tp.clone().sub(eye);
      wantYaw = Math.atan2(-to.x, -to.z);
      wantPitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
      if (!this.alarmed) {
        this.alarmed = true;
        Events.emit('arc:alarm', { pos: this.pos.clone(), target: tp.clone() });
      }
    } else if (this.perception.investigate && ctx.time - this.perception.investigateAt < 6) {
      const to = this.perception.investigate.clone().sub(eye);
      wantYaw = Math.atan2(-to.x, -to.z);
    } else {
      // Sweep ±SCAN_ARC around facing
      this.alarmed = false;
      wantYaw = this.headYaw + this.scanDir * 0.5 * dt * 10;
      let off = wantYaw - this.facing;
      off = Math.atan2(Math.sin(off), Math.cos(off));
      if (Math.abs(off) > SCAN_ARC) this.scanDir *= -1;
    }
    let dy = wantYaw - this.headYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const turn = (tp ? TURN : 0.5) * dt;
    this.headYaw += THREE.MathUtils.clamp(dy, -turn, turn);
    this.headPitch += THREE.MathUtils.clamp(wantPitch - this.headPitch, -turn, turn);

    // Lock → burst cycle
    const onTarget = Math.abs(dy) < 0.08;
    if (visible && onTarget) this.lockT += dt;
    else this.lockT = Math.max(0, this.lockT - dt * 2);
    const lockNeeded = 0.5 + d.reactionTime;
    this.beepT -= dt;
    if (this.lockT > 0 && this.lockT < lockNeeded && this.beepT <= 0) {
      Sfx.beep(this.pos, this.lockT > lockNeeded * 0.6);
      this.beepT = 0.18;
    }
    this.cooldown -= dt;
    if (this.lockT >= lockNeeded && this.cooldown <= 0 && this.burstLeft === 0 && visible) {
      this.burstLeft = 6;
      this.aim.newBurst(d);
    }
    if (this.burstLeft > 0) {
      this.shotT -= dt;
      if (this.shotT <= 0) {
        const info = target ? this.perception.info(target) : undefined;
        if (info && visible) {
          const muzzle = eye.clone().addScaledVector(this.forward(new THREE.Vector3()), 0.9);
          arcBolt(ctx, this, muzzle, this.aim.direction(muzzle, info.lastPos, undefined, info.velocity, BOLT_SPEED, d, 0.5), BOLT_DAMAGE, BOLT_SPEED);
        }
        this.burstLeft--;
        this.shotT = 0.12;
        if (this.burstLeft === 0) this.cooldown = 1.4;
      }
    }
  }

  fixedStep(): void {}

  render(dt: number): void {
    const m = this.model;
    m.head.rotation.set(this.headPitch, this.headYaw, 0, 'YXZ');
    this.updateFlash(dt);
    if (!this.health.alive) {
      m.laser.visible = false;
      m.eyeMat.emissiveIntensity = 0;
      m.head.rotation.x = -0.6;
      return;
    }
    // Laser: from eye to first hit
    const eye = this.eye(new THREE.Vector3());
    const fwd = this.forward(new THREE.Vector3());
    const hit = this.ctx.physics.raycast(eye.clone().addScaledVector(fwd, 0.6), fwd, 140, undefined, this._body);
    this.laserEnd.copy(hit ? hit.point : eye.clone().addScaledVector(fwd, 140));
    const geo = m.laser.geometry as THREE.BufferGeometry;
    const a = geo.attributes.position as THREE.BufferAttribute;
    const e = eye.clone().addScaledVector(fwd, 0.5).sub(this.pos);
    const t = this.laserEnd.clone().sub(this.pos);
    a.setXYZ(0, e.x, e.y, e.z);
    a.setXYZ(1, t.x, t.y, t.z);
    a.needsUpdate = true;
    const locking = this.lockT > 0;
    m.laserMat.color.set(locking ? '#ff2a1a' : '#ffae40');
    m.laserMat.opacity = locking ? 0.95 : 0.5;
    m.eyeMat.emissiveIntensity = locking ? 4 + Math.sin(this.ctx.time * 30) * 2 : 2;
  }
}
