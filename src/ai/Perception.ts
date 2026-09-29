import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { hostile, type Damageable } from '../combat/Damage';
import type { AIContext } from './AIContext';
import { SenseMods } from './SenseMods'; // W4: weather + smoke

export interface Awareness {
  /** 0..1 detection meter. */
  level: number;
  /** Reached full detection (or was shot by them); stays hostile until forgotten. */
  confirmed: boolean;
  visible: boolean;
  lastPos: THREE.Vector3;
  lastSeen: number;
  velocity: THREE.Vector3;
}

export interface PerceptionOpts {
  range: number;
  fovDeg: number;
  hearing: number;
  detect: number;
  /** Seconds between sight checks. */
  interval?: number;
}

const TICK = 0.12;
const MEMORY = 14;
const _to = new THREE.Vector3();
const _pts: THREE.Vector3[] = [];

/**
 * Sight (cone + line of sight + detection meter), hearing (noise events) and
 * damage awareness. Picks the most pressing hostile as `target`.
 */
export class Perception {
  readonly known = new Map<Damageable, Awareness>();
  target: Damageable | null = null;
  /** Point to check out (noise, lost target, suspicion). */
  investigate: THREE.Vector3 | null = null;
  investigateAt = 0;
  alertedAt = -99;
  private acc = Math.random() * TICK;

  constructor(
    private owner: Damageable,
    public opts: PerceptionOpts,
    /** Owner's rigid body, excluded from line-of-sight rays (eyes sit inside colliders). */
    private bodyOf: () => RAPIER.RigidBody | undefined = () => undefined,
  ) {}

  get alerted(): boolean {
    return this.target !== null;
  }

  info(t: Damageable): Awareness | undefined {
    return this.known.get(t);
  }

  /** Best position to shoot at / move toward for the current target. */
  targetPos(out = new THREE.Vector3()): THREE.Vector3 | null {
    if (!this.target) return null;
    const a = this.known.get(this.target);
    return a ? out.copy(a.lastPos) : null;
  }

  get targetVisible(): boolean {
    return !!this.target && !!this.known.get(this.target)?.visible;
  }

  update(ctx: AIContext, dt: number, eye: THREE.Vector3, forward: THREE.Vector3): void {
    this.acc += dt;
    if (this.acc < (this.opts.interval ?? TICK)) {
      // Decay meters between checks
      return;
    }
    const step = this.acc;
    this.acc = 0;
    const cosHalf = Math.cos(THREE.MathUtils.degToRad(this.opts.fovDeg / 2));
    const range = this.opts.range * SenseMods.vision; // W4: weather vision multiplier
    const body = this.bodyOf();

    for (const t of ctx.registry.targets) {
      if (t === this.owner || !t.health.alive || t.faction === 'neutral' || t.faction === 'dummy') continue;
      if (!hostile(t.faction, this.owner.faction)) continue;
      _pts.length = 0;
      t.aimPoints(_pts);
      if (!_pts.length) continue;
      const chest = _pts[0];
      _to.subVectors(chest, eye);
      const d = _to.length();
      let a = this.known.get(t);
      if (d > range * 1.3 && !a) continue;
      if (!a) {
        a = { level: 0, confirmed: false, visible: false, lastPos: chest.clone(), lastSeen: -99, velocity: new THREE.Vector3() };
        this.known.set(t, a);
      }
      const dir = _to.divideScalar(d || 1);
      const dot = dir.dot(forward);
      const close = d < 4;
      let seen = false;
      if ((dot > cosHalf || close) && d < range) {
        // Line of sight to chest, then head
        for (const p of _pts) {
          _to.subVectors(p, eye);
          const pd = _to.length();
          if (SenseMods.smokeBlocks(eye, p)) continue; // W4: smoke blocks line of sight
          const hit = ctx.physics.raycast(eye, _to.divideScalar(pd), pd + 0.5, undefined, body);
          if (!hit || ctx.registry.lookup(hit.collider) === t) {
            seen = true;
            break;
          }
        }
      }
      if (seen) {
        const st = t.stance?.();
        let gain = this.opts.detect * 2.4 * Math.sqrt(Math.max(0, 1 - d / range));
        if (st) gain *= st.crouched ? 0.55 : 1;
        if (st) gain *= st.speed > 5.5 ? 1.5 : st.speed > 1 ? 1.15 : 0.9;
        if (dot < Math.cos(THREE.MathUtils.degToRad(this.opts.fovDeg * 0.2))) gain *= 0.5; // peripheral
        if (d < 8) gain *= 3;
        if (a.confirmed) gain = 10;
        a.level = Math.min(1, a.level + gain * step);
        if (a.level >= 1) a.confirmed = true;
        if (st) a.velocity.copy(st.velocity);
        a.visible = true;
        a.lastPos.copy(chest);
        a.lastSeen = ctx.time;
      } else {
        a.visible = false;
        if (!a.confirmed) a.level = Math.max(0, a.level - 0.25 * step);
        if (ctx.time - a.lastSeen > MEMORY) {
          if (a.confirmed) {
            a.confirmed = false;
            a.level = 0.5;
          } else if (a.level <= 0) this.known.delete(t);
        }
      }
      if (a.level > 0.35 && a.level < 1 && seen) this.setInvestigate(a.lastPos, ctx.time);
    }
    this.pickTarget(ctx, eye);
  }

  private pickTarget(ctx: AIContext, eye: THREE.Vector3): void {
    let best: Damageable | null = null;
    let bestScore = Infinity;
    for (const [t, a] of this.known) {
      if (!t.health.alive) {
        this.known.delete(t);
        continue;
      }
      if (!a.confirmed) continue;
      const age = ctx.time - a.lastSeen;
      if (age > MEMORY) continue;
      const score = a.lastPos.distanceTo(eye) + age * 12 + (a.visible ? 0 : 25) + (t === this.target ? -15 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    if (best && best !== this.target) this.alertedAt = ctx.time;
    this.target = best;
  }

  setInvestigate(p: THREE.Vector3, time: number): void {
    this.investigate = (this.investigate ?? new THREE.Vector3()).copy(p);
    this.investigateAt = time;
  }

  /** Noise heard: footsteps, gunshots, explosions. */
  hear(ctx: AIContext, pos: THREE.Vector3, radius: number, eye: THREE.Vector3, source?: Damageable): void {
    const d = pos.distanceTo(eye);
    const hearing = this.opts.hearing * SenseMods.hearing; // W4: weather hearing multiplier
    if (d > radius * hearing) return;
    if (source) {
      if (source === this.owner || !hostile(source.faction, this.owner.faction) || source.faction === 'neutral') return;
      let a = this.known.get(source);
      if (!a) {
        a = { level: 0, confirmed: false, visible: false, lastPos: pos.clone(), lastSeen: ctx.time - 3, velocity: new THREE.Vector3() };
        this.known.set(source, a);
      }
      // Loud + close noises almost confirm; distant ones raise suspicion
      a.level = Math.min(1, a.level + (1 - d / (radius * hearing)) * (radius > 40 ? 0.9 : 0.35));
      if (a.level >= 1) a.confirmed = true;
      a.lastPos.copy(pos);
      a.lastSeen = Math.max(a.lastSeen, ctx.time - 2);
    }
    this.setInvestigate(pos, ctx.time);
  }

  /** Took damage: attacker is revealed. */
  damagedBy(ctx: AIContext, attacker: Damageable | undefined, origin: THREE.Vector3): void {
    if (attacker && attacker !== this.owner) {
      let a = this.known.get(attacker);
      if (!a) {
        a = { level: 1, confirmed: true, visible: false, lastPos: origin.clone(), lastSeen: ctx.time, velocity: new THREE.Vector3() };
        this.known.set(attacker, a);
      }
      a.level = 1;
      a.confirmed = true;
      a.lastPos.copy(origin);
      a.lastSeen = ctx.time;
      if (!this.target) {
        this.target = attacker;
        this.alertedAt = ctx.time;
      }
    }
    this.setInvestigate(origin, ctx.time);
  }

  reset(): void {
    this.known.clear();
    this.target = null;
    this.investigate = null;
  }
}
