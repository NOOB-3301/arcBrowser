import * as THREE from 'three';
import { applyDirect, hostile, type DamageSource } from '../../combat/Damage';
import type { AIContext } from '../AIContext';
import type { Bot } from '../Bot';

const _pts: THREE.Vector3[] = [];
const _p = new THREE.Vector3();

/**
 * W4: thick continuous beam. Raycasts for the first world hit, then damages every
 * hostile whose aim points lie within `radius` of the beam segment.
 * Returns the beam end point (into `out`).
 */
export function beamDamage(
  ctx: AIContext,
  bot: Bot,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  maxLen: number,
  radius: number,
  amount: number,
  out: THREE.Vector3,
): { point: THREE.Vector3; normal: THREE.Vector3 | null } {
  const hit = ctx.physics.raycast(origin, dir, maxLen, undefined, bot.body);
  const len = hit ? hit.distance : maxLen;
  out.copy(origin).addScaledVector(dir, len);
  if (amount > 0) {
    for (const t of ctx.registry.targets) {
      if (t === bot || !t.health.alive || !hostile(t.faction, bot.faction) || t.faction === 'neutral' || t.faction === 'dummy') continue;
      _pts.length = 0;
      t.aimPoints(_pts);
      for (const p of _pts) {
        const s = THREE.MathUtils.clamp(_p.subVectors(p, origin).dot(dir), 0, len + 0.6);
        _p.copy(origin).addScaledVector(dir, s);
        if (_p.distanceTo(p) > radius) continue;
        const source: DamageSource = {
          amount, penetration: 0.5, headMultiplier: 1, team: 'arc', faction: bot.faction, attacker: bot,
          origin: origin.clone(), direction: dir.clone(), byPlayer: false, weaponId: `arc-${bot.kind}-laser`,
        };
        applyDirect(t, amount, p.clone(), source);
        break;
      }
    }
  }
  return { point: out, normal: hit ? hit.normal : null };
}
