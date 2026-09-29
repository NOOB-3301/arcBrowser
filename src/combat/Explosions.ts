import * as THREE from 'three';
import { Events } from '../core/Events';
import { applyDirect, type DamageRegistry, type DamageSource, type Team } from './Damage';
import type { Effects } from './Effects';
import type { Physics } from '../physics/Physics';
import type RAPIER from '@dimforge/rapier3d-compat';
import { Sfx } from '../audio/Sfx';

const _pts: THREE.Vector3[] = [];

/**
 * Radial damage with line-of-sight occlusion and quadratic falloff.
 * Emits 'explosion' (camera shake) and a loud 'noise'.
 */
export function explode(
  physics: Physics,
  registry: DamageRegistry,
  effects: Effects,
  pos: THREE.Vector3,
  opts: { radius: number; damage: number; faction: string; team: Team; byPlayer?: boolean; size?: number; excludeBody?: RAPIER.RigidBody; attacker?: import('./Damage').Damageable },
): void {
  effects.explosion(pos, opts.size ?? 1);
  Sfx.explosion(pos, opts.size ?? 1);
  Events.emit('explosion', { pos: pos.clone(), radius: opts.radius, size: opts.size ?? 1 });
  Events.emit('noise', { pos: pos.clone(), radius: 120, source: 'explosion' });

  const origin = pos.clone().add(new THREE.Vector3(0, 0.3, 0));
  for (const t of [...registry.targets]) {
    if (!t.health.alive) continue;
    _pts.length = 0;
    t.aimPoints(_pts);
    let best: THREE.Vector3 | null = null;
    let bd = Infinity;
    for (const p of _pts) {
      const d = p.distanceTo(origin);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    if (!best || bd > opts.radius) continue;
    // Occlusion: world geometry between blast and target blocks it
    const dir = best.clone().sub(origin);
    const len = dir.length();
    const hit = physics.raycast(origin, dir.divideScalar(len || 1), len, undefined, opts.excludeBody);
    if (hit && registry.lookup(hit.collider) !== t && hit.distance < len - 0.4) continue;
    // Full damage in the core, linear falloff to the edge
    const core = opts.radius * 0.33;
    const k = bd <= core ? 1 : 1 - (bd - core) / (opts.radius - core);
    const source: DamageSource = {
      amount: opts.damage * k,
      penetration: 1,
      headMultiplier: 1,
      team: opts.team,
      faction: opts.faction,
      attacker: opts.attacker,
      origin: pos.clone(),
      direction: dir,
      byPlayer: !!opts.byPlayer,
    };
    applyDirect(t, source.amount, best, source);
  }
}
