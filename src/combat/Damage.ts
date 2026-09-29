import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { Events } from '../core/Events';
import type { Health } from './Health';

export type ZoneKind = 'body' | 'head' | 'limb' | 'weakpoint' | 'armor';
export type Team = 'player' | 'raider' | 'arc' | 'neutral';

export interface HitZone {
  kind: ZoneKind;
  multiplier: number;
  /** 0..1 damage reduction, reduced by weapon penetration. */
  armor?: number;
}

/** Surface material decides impact FX. */
export type Surface = 'dirt' | 'concrete' | 'metal' | 'flesh' | 'machine';

export interface Damageable {
  readonly id: number;
  readonly team: Team;
  readonly health: Health;
  readonly surface: Surface;
  /** Zone for a hit on one of this target's colliders at a world point. */
  zoneFor(collider: RAPIER.Collider, point: THREE.Vector3): HitZone;
  /** Points aim assist can pull toward (centre mass, head). */
  aimPoints(out: THREE.Vector3[]): void;
  onDamaged?(info: DamageResult): void;
}

export interface DamageSource {
  amount: number;
  penetration: number;
  /** Multiplier applied only to head zones (weapon-specific). */
  headMultiplier: number;
  team: Team;
  weaponId?: string;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  /** Player-caused (drives hitmarkers). */
  byPlayer: boolean;
}

export interface DamageResult {
  target: Damageable;
  zone: HitZone;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  dealt: number;
  toShield: number;
  toHp: number;
  killed: boolean;
  source: DamageSource;
}

let nextId = 1;
export function newTargetId(): number {
  return nextId++;
}

/** Maps collider handles → damageable owner. */
export class DamageRegistry {
  private byCollider = new Map<number, Damageable>();
  readonly targets = new Set<Damageable>();

  register(target: Damageable, ...colliders: RAPIER.Collider[]): void {
    this.targets.add(target);
    for (const c of colliders) this.byCollider.set(c.handle, target);
  }

  unregister(target: Damageable): void {
    this.targets.delete(target);
    for (const [h, t] of this.byCollider) if (t === target) this.byCollider.delete(h);
  }

  lookup(collider: RAPIER.Collider): Damageable | undefined {
    return this.byCollider.get(collider.handle);
  }

  /** Resolve and apply a hit. Returns null if the collider isn't damageable. */
  apply(
    collider: RAPIER.Collider,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    source: DamageSource,
  ): DamageResult | null {
    const target = this.lookup(collider);
    if (!target || !target.health.alive) return null;
    if (target.team === source.team && source.team !== 'neutral') return null; // no friendly fire
    const zone = target.zoneFor(collider, point);
    // Head zones use the weapon's headshot multiplier; other zones their own
    let amount = source.amount * (zone.kind === 'head' ? source.headMultiplier : zone.multiplier);
    if (zone.armor) amount *= 1 - zone.armor * (1 - source.penetration);
    const { toShield, toHp, killed } = target.health.damage(amount);
    const result: DamageResult = { target, zone, point, normal, dealt: toShield + toHp, toShield, toHp, killed, source };
    target.onDamaged?.(result);
    Events.emit('damage', result);
    if (killed) Events.emit('kill', result);
    return result;
  }
}

/** Linear falloff between start and end distances down to minMult. */
export function falloff(dist: number, start: number, end: number, minMult: number): number {
  if (dist <= start) return 1;
  if (dist >= end) return minMult;
  return 1 - ((dist - start) / (end - start)) * (1 - minMult);
}
