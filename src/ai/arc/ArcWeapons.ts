import * as THREE from 'three';
import { Events } from '../../core/Events';
import { Sfx } from '../../audio/Sfx';
import type { AIContext } from '../AIContext';
import type { Bot } from '../Bot';

/** ARC energy bolt: fast, no drop, bright red tracer. */
export function arcBolt(ctx: AIContext, bot: Bot, origin: THREE.Vector3, dir: THREE.Vector3, damage: number, speed: number): void {
  ctx.ballistics.fire({
    origin,
    dir,
    speed,
    gravity: 0,
    damage: damage * ctx.difficulty.damageMult,
    falloff: { start: 40, end: 140, min: 0.6 },
    penetration: 0.3,
    headMultiplier: 1.5,
    team: 'arc',
    faction: 'arc',
    attacker: bot,
    shooterBody: bot.body,
    byPlayer: false,
    weaponId: `arc-${bot.kind}`,
    color: 0xff4a28,
    heavyTracer: true,
  });
  ctx.effects.muzzleFlash(origin, 0xff5a30, 0.7);
  Sfx.shot('energy', false, true, origin);
  Events.emit('noise', { emitter: bot, pos: origin.clone(), radius: 70, source: 'gunshot' });
}

/** Snap a ground unit to the floor below (buildings, pads) or terrain. */
export function groundY(ctx: AIContext, bot: Bot, x: number, y: number, z: number): number {
  const hit = ctx.physics.raycast(new THREE.Vector3(x, y + 1.2, z), new THREE.Vector3(0, -1, 0), 4, undefined, bot.body);
  if (hit && hit.normal.y > 0.5) return hit.point.y;
  return ctx.nav.floorAt(x, z);
}
