import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../physics/Physics';
import { Events } from '../core/Events';
import { falloff, type DamageRegistry, type DamageSource, type Surface, type Team } from '../combat/Damage';
import type { Effects } from '../combat/Effects';
import type { Falloff } from './WeaponDefs';

const MAX_LIFE = 2.5;
const MAX_RANGE = 700;
const G = 9.81;

export interface ProjectileSpec {
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  gravity: number;
  damage: number;
  falloff: Falloff;
  penetration: number;
  headMultiplier: number;
  team: Team;
  shooter?: RAPIER.Collider;
  byPlayer: boolean;
  weaponId: string;
  color: number;
  /** Thicker, brighter tracer (energy bolts). */
  heavyTracer?: boolean;
  chain?: { range: number; targets: number; damageMult: number };
}

interface Projectile extends ProjectileSpec {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  travelled: number;
  life: number;
  colorObj: THREE.Color;
}

/**
 * Every bullet is a fast projectile ray-marched per fixed step, so range,
 * travel time and drop come for free. Hits resolve against the damage registry.
 */
export class Ballistics {
  private live: Projectile[] = [];
  private _seg = new THREE.Vector3();

  constructor(
    private physics: Physics,
    private registry: DamageRegistry,
    private effects: Effects,
  ) {}

  fire(spec: ProjectileSpec): void {
    this.live.push({
      ...spec,
      pos: spec.origin.clone(),
      vel: spec.dir.clone().normalize().multiplyScalar(spec.speed),
      travelled: 0,
      life: 0,
      colorObj: new THREE.Color(spec.color),
    });
  }

  /** Fixed-step simulation. */
  step(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.life += dt;
      const next = p.pos.clone().addScaledVector(p.vel, dt);
      next.y -= 0.5 * G * p.gravity * dt * dt;
      p.vel.y -= G * p.gravity * dt;

      const seg = this._seg.subVectors(next, p.pos);
      const len = seg.length();
      if (len > 1e-6) {
        seg.divideScalar(len);
        const hit = this.physics.raycast(p.pos, seg, len, p.shooter);
        if (hit) {
          this.resolveHit(p, hit.point, hit.normal, hit.collider, p.travelled + hit.distance);
          this.live.splice(i, 1);
          continue;
        }
      }
      p.pos.copy(next);
      p.travelled += len;
      if (p.life > MAX_LIFE || p.travelled > MAX_RANGE || p.pos.y < -100) this.live.splice(i, 1);
    }
  }

  /** Push tracer geometry for this frame. */
  render(): void {
    this.effects.beginTracers();
    for (const p of this.live) {
      const speed = p.vel.length();
      const tailLen = Math.min(p.travelled, p.heavyTracer ? 10 : 4 + speed * 0.008);
      if (tailLen < 0.5) continue;
      const tail = p.pos.clone().addScaledVector(p.vel, -tailLen / speed);
      this.effects.addTracer(p.pos, tail, p.colorObj, p.heavyTracer ? 2.2 : 1.2);
    }
  }

  get count(): number {
    return this.live.length;
  }

  private resolveHit(p: Projectile, point: THREE.Vector3, normal: THREE.Vector3, collider: RAPIER.Collider, dist: number): void {
    const source: DamageSource = {
      amount: p.damage * falloff(dist, p.falloff.start, p.falloff.end, p.falloff.min),
      penetration: p.penetration,
      headMultiplier: p.headMultiplier,
      team: p.team,
      weaponId: p.weaponId,
      origin: p.origin,
      direction: p.vel.clone().normalize(),
      byPlayer: p.byPlayer,
    };
    const target = this.registry.lookup(collider);
    const result = this.registry.apply(collider, point, normal, source);
    let surface: Surface;
    if (target) surface = result?.zone.kind === 'armor' ? 'metal' : target.surface;
    else surface = normal.y > 0.8 && point.y < 0.08 ? 'dirt' : 'concrete';
    this.effects.impact(point, normal, surface, !target);
    Events.emit('impact', { point, normal, surface, byPlayer: p.byPlayer, target: !!target });

    // Chain lightning to nearby targets
    if (result && p.chain) {
      const candidates: { t: typeof result.target; d: number; aim: THREE.Vector3 }[] = [];
      const pts: THREE.Vector3[] = [];
      for (const t of this.registry.targets) {
        if (t === result.target || !t.health.alive || t.team === p.team) continue;
        pts.length = 0;
        t.aimPoints(pts);
        if (!pts.length) continue;
        const d = pts[0].distanceTo(point);
        if (d <= p.chain.range) candidates.push({ t, d, aim: pts[0].clone() });
      }
      candidates.sort((a, b) => a.d - b.d);
      let from = point.clone();
      for (const c of candidates.slice(0, p.chain.targets)) {
        this.effects.lightning(from, c.aim);
        const dmg = c.t.health.damage(source.amount * p.chain.damageMult);
        const chained = {
          target: c.t, zone: { kind: 'body' as const, multiplier: 1 }, point: c.aim, normal: new THREE.Vector3(0, 1, 0),
          dealt: dmg.toHp + dmg.toShield, toShield: dmg.toShield, toHp: dmg.toHp, killed: dmg.killed, source,
        };
        c.t.onDamaged?.(chained);
        Events.emit('damage', chained);
        if (dmg.killed) Events.emit('kill', chained);
        from = c.aim;
      }
    }
  }
}
