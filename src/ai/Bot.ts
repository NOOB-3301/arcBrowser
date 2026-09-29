import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { Health } from '../combat/Health';
import { newTargetId, type Damageable, type DamageResult, type HitZone, type Surface, type Team } from '../combat/Damage';
import { Perception } from './Perception';
import type { AIContext } from './AIContext';

export type BotKind = 'tick' | 'wasp' | 'sentinel' | 'raider';

/** Shared plumbing for every AI unit: health, perception, registration, disposal. */
export abstract class Bot implements Damageable {
  readonly id = newTargetId();
  abstract readonly kind: BotKind;
  readonly health: Health;
  readonly perception: Perception;
  /** Root position (feet for walkers, centre for flyers). */
  readonly pos = new THREE.Vector3();
  readonly group = new THREE.Group();
  /** Seconds since death (for corpse cleanup). */
  deadT = 0;
  removed = false;
  /** Distance to the player last frame (AI LOD). */
  focusDist = 0;
  protected hitFlash = 0;
  protected flashMats: THREE.MeshStandardMaterial[] = [];
  protected aimPts = [new THREE.Vector3(), new THREE.Vector3()];

  constructor(
    protected ctx: AIContext,
    readonly team: Team,
    readonly faction: string,
    readonly surface: Surface,
    hp: number,
    shield = 0,
  ) {
    this.health = new Health(hp * ctx.difficulty.healthMult, shield);
    const d = ctx.difficulty;
    this.perception = new Perception(this, { range: d.visionRange, fovDeg: d.visionFovDeg, hearing: d.hearingMult, detect: d.detectSpeed }, () => (this.removed ? undefined : this.body));
    ctx.scene.add(this.group);
  }

  abstract get body(): RAPIER.RigidBody;
  abstract zoneFor(c: RAPIER.Collider, point: THREE.Vector3): HitZone;
  abstract aimPoints(out: THREE.Vector3[]): void;
  /** Eye position + look direction for perception. */
  abstract eye(out: THREE.Vector3): THREE.Vector3;
  abstract forward(out: THREE.Vector3): THREE.Vector3;
  /** AI decisions, per render frame (may be throttled by LOD). */
  abstract think(dt: number): void;
  /** Movement integration at the fixed physics rate. */
  abstract fixedStep(dt: number): void;
  /** Visual update, per render frame. */
  abstract render(dt: number): void;
  protected onDeath(): void {}

  onDamaged(r: DamageResult): void {
    this.hitFlash = 0.08;
    if (r.source.attacker !== this) this.perception.damagedBy(this.ctx, r.source.attacker, r.source.origin);
    if (r.killed) {
      this.deadT = 0;
      this.disableColliders();
      this.onDeath();
    }
  }

  /** Corpses stop blocking bullets, blasts and movement. */
  protected disableColliders(): void {
    const b = this.body;
    for (let i = 0; i < b.numColliders(); i++) b.collider(i).setEnabled(false);
  }

  hear(pos: THREE.Vector3, radius: number, source?: Damageable): void {
    if (!this.health.alive) return;
    this.perception.hear(this.ctx, pos, radius, this.eye(new THREE.Vector3()), source);
  }

  protected updateFlash(dt: number): void {
    this.hitFlash -= dt;
    const on = this.hitFlash > 0;
    for (const m of this.flashMats) m.emissive.setRGB(on ? 0.9 : 0, on ? 0.9 : 0, on ? 0.9 : 0);
  }

  dispose(): void {
    if (this.removed) return;
    this.removed = true;
    this.ctx.scene.remove(this.group);
    this.ctx.registry.unregister(this);
    this.ctx.physics.world.removeRigidBody(this.body);
  }
}
