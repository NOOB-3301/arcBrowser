import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { RAPIER as R, Groups, interactionGroups, type Physics } from '../physics/Physics';
import { Health } from '../combat/Health';
import { newTargetId, type Damageable, type DamageRegistry, type DamageResult, type HitZone, type Surface, type Team } from '../combat/Damage';
import { Events } from '../core/Events';
import { FIXED_DT } from '../core/Time';

const BODY: HitZone = { kind: 'body', multiplier: 1 };
const HEAD: HitZone = { kind: 'head', multiplier: 1.5 };
const LIMB: HitZone = { kind: 'limb', multiplier: 0.8 };

function fixedBody(physics: Physics, pos: THREE.Vector3, kinematic = false): RAPIER.RigidBody {
  const desc = kinematic ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.fixed();
  return physics.world.createRigidBody(desc.setTranslation(pos.x, pos.y, pos.z));
}
function groups(): number {
  return interactionGroups(Groups.BOT, 0xffff);
}

/** Humanoid training dummy: body + head hitboxes, falls over on death, respawns. */
class Dummy implements Damageable {
  readonly id = newTargetId();
  readonly team: Team = 'arc';
  readonly surface: Surface = 'machine';
  readonly health: Health;
  readonly group = new THREE.Group();
  body: RAPIER.RigidBody;
  private bodyCol: RAPIER.Collider;
  private headCol: RAPIER.Collider;
  private legCol: RAPIER.Collider;
  private flashT = 0;
  private deadT = 0;
  private mats: THREE.MeshStandardMaterial[] = [];
  private aim = [new THREE.Vector3(), new THREE.Vector3()];
  /** Moving dummies strafe along X. */
  private strafe: { amp: number; speed: number; t: number; base: THREE.Vector3 } | null = null;

  constructor(scene: THREE.Scene, physics: Physics, registry: DamageRegistry, readonly pos: THREE.Vector3, hp: number, shield: number, label: string) {
    this.health = new Health(hp, shield);
    this.body = fixedBody(physics, pos, true);
    // Colliders relative to feet position
    this.legCol = physics.world.createCollider(R.ColliderDesc.cuboid(0.18, 0.42, 0.12).setTranslation(0, 0.42, 0).setCollisionGroups(groups()), this.body);
    this.bodyCol = physics.world.createCollider(R.ColliderDesc.cuboid(0.24, 0.32, 0.14).setTranslation(0, 1.16, 0).setCollisionGroups(groups()), this.body);
    this.headCol = physics.world.createCollider(R.ColliderDesc.ball(0.14).setTranslation(0, 1.66, 0).setCollisionGroups(groups()), this.body);
    registry.register(this, this.bodyCol, this.headCol, this.legCol);

    const mk = (color: string) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.3 });
      this.mats.push(m);
      return m;
    };
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, y: number) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.y = y;
      mesh.castShadow = true;
      this.group.add(mesh);
    };
    add(new THREE.BoxGeometry(0.36, 0.84, 0.24), mk('#5d6a73'), 0.42);
    add(new THREE.BoxGeometry(0.48, 0.64, 0.28), mk(shield > 0 ? '#3f7fb0' : '#7b8790'), 1.16);
    add(new THREE.SphereGeometry(0.14, 12, 10), mk('#d06a2a'), 1.66);
    // Label plate
    const tag = makeLabel(label);
    tag.position.y = 2.1;
    this.group.add(tag);
    this.group.position.copy(pos);
    scene.add(this.group);
  }

  setStrafe(amp: number, speed: number): void {
    this.strafe = { amp, speed, t: 0, base: this.pos.clone() };
  }

  zoneFor(c: RAPIER.Collider): HitZone {
    if (c.handle === this.headCol.handle) return HEAD;
    if (c.handle === this.legCol.handle) return LIMB;
    return BODY;
  }

  aimPoints(out: THREE.Vector3[]): void {
    const p = this.group.position;
    out.push(this.aim[0].set(p.x, p.y + 1.16, p.z), this.aim[1].set(p.x, p.y + 1.66, p.z));
  }

  onDamaged(r: DamageResult): void {
    this.flashT = 0.08;
    if (r.killed) this.deadT = 3;
  }

  step(dt: number): void {
    if (this.strafe && this.health.alive) {
      const s = this.strafe;
      s.t += dt;
      const x = s.base.x + Math.sin(s.t * s.speed) * s.amp;
      this.body.setNextKinematicTranslation({ x, y: s.base.y, z: s.base.z });
    }
  }

  update(dt: number): void {
    const t = this.body.translation();
    this.group.position.set(t.x, t.y, t.z);
    this.flashT -= dt;
    for (const m of this.mats) m.emissive.setRGB(this.flashT > 0 ? 0.6 : 0, this.flashT > 0 ? 0.15 : 0, 0);
    if (!this.health.alive) {
      this.group.rotation.x = Math.min(this.group.rotation.x + dt * 4, Math.PI / 2);
      this.deadT -= dt;
      if (this.deadT <= 0) {
        this.health.reset();
        this.group.rotation.x = 0;
      }
    }
  }
}

/** Steel gong: infinite health, rings on hit. */
class Plate implements Damageable {
  readonly id = newTargetId();
  readonly team: Team = 'neutral';
  readonly surface: Surface = 'metal';
  readonly health = new Health(1e9);
  private mat = new THREE.MeshStandardMaterial({ color: '#c9c3b5', roughness: 0.35, metalness: 0.8 });
  private flashT = 0;
  private aim: THREE.Vector3;

  constructor(scene: THREE.Scene, physics: Physics, registry: DamageRegistry, pos: THREE.Vector3, size: number) {
    const body = fixedBody(physics, pos);
    const col = physics.world.createCollider(R.ColliderDesc.cuboid(size / 2, size / 2, 0.03).setCollisionGroups(groups()), body);
    registry.register(this, col);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, 0.06), this.mat);
    mesh.position.copy(pos);
    mesh.castShadow = true;
    scene.add(mesh);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, pos.y, 0.08), new THREE.MeshStandardMaterial({ color: '#3a3a3a' }));
    post.position.set(pos.x, pos.y / 2 - size / 2, pos.z + 0.05);
    scene.add(post);
    this.aim = pos.clone();
  }

  zoneFor(): HitZone {
    return BODY;
  }
  aimPoints(): void {
    // Plates don't attract aim assist
  }
  onDamaged(r: DamageResult): void {
    this.flashT = 0.12;
    this.health.reset();
    Events.emit('plate:ring', { point: r.point, dist: r.source.origin.distanceTo(this.aim) });
  }
  update(dt: number): void {
    this.flashT -= dt;
    this.mat.emissive.setRGB(this.flashT > 0 ? 1 : 0, this.flashT > 0 ? 0.8 : 0, this.flashT > 0 ? 0.3 : 0);
  }
}

/**
 * ARC plating test rig: heavy front armour (only high-pen rounds get through),
 * exposed glowing core weakpoint, lighter side panels.
 */
class ArmorRig implements Damageable {
  readonly id = newTargetId();
  readonly team: Team = 'arc';
  readonly surface: Surface = 'machine';
  readonly health = new Health(400);
  private plateCol: RAPIER.Collider;
  private coreCol: RAPIER.Collider;
  private flashT = 0;
  private deadT = 0;
  private core: THREE.MeshStandardMaterial;
  private hull: THREE.MeshStandardMaterial;
  private aim: THREE.Vector3;

  constructor(scene: THREE.Scene, physics: Physics, registry: DamageRegistry, pos: THREE.Vector3) {
    const body = fixedBody(physics, pos);
    const bodyCol = physics.world.createCollider(R.ColliderDesc.cuboid(0.7, 0.6, 0.6).setCollisionGroups(groups()), body);
    this.plateCol = physics.world.createCollider(R.ColliderDesc.cuboid(0.75, 0.45, 0.06).setTranslation(0, -0.1, 0.66).setCollisionGroups(groups()), body);
    this.coreCol = physics.world.createCollider(R.ColliderDesc.ball(0.2).setTranslation(0, 0.5, 0.55).setCollisionGroups(groups()), body);
    registry.register(this, bodyCol, this.plateCol, this.coreCol);

    this.hull = new THREE.MeshStandardMaterial({ color: '#57606a', roughness: 0.45, metalness: 0.7 });
    this.core = new THREE.MeshStandardMaterial({ color: '#ff5a2a', emissive: '#ff3a10', emissiveIntensity: 1.5 });
    const g = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 1.2), this.hull);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.9, 0.12), new THREE.MeshStandardMaterial({ color: '#8a8f94', roughness: 0.3, metalness: 0.9 }));
    plate.position.set(0, -0.1, 0.66);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), this.core);
    core.position.set(0, 0.5, 0.55);
    for (const m of [hull, plate, core]) {
      m.castShadow = true;
      g.add(m);
    }
    const tag = makeLabel('ARC PLATING RIG');
    tag.position.y = 1.2;
    g.add(tag);
    g.position.copy(pos);
    scene.add(g);
    this.aim = pos.clone().add(new THREE.Vector3(0, 0.5, 0.55));
  }

  zoneFor(c: RAPIER.Collider): HitZone {
    if (c.handle === this.coreCol.handle) return { kind: 'weakpoint', multiplier: 2.5 };
    if (c.handle === this.plateCol.handle) return { kind: 'armor', multiplier: 1, armor: 0.85 };
    return { kind: 'body', multiplier: 0.8, armor: 0.4 };
  }
  aimPoints(out: THREE.Vector3[]): void {
    if (this.health.alive) out.push(this.aim);
  }
  onDamaged(r: DamageResult): void {
    this.flashT = 0.08;
    if (r.killed) this.deadT = 4;
  }
  update(dt: number): void {
    this.flashT -= dt;
    this.hull.emissive.setRGB(this.flashT > 0 ? 0.3 : 0, this.flashT > 0 ? 0.3 : 0, this.flashT > 0 ? 0.35 : 0);
    this.core.emissiveIntensity = this.health.alive ? 1.5 + Math.sin(performance.now() / 150) * 0.4 : 0;
    if (!this.health.alive) {
      this.deadT -= dt;
      if (this.deadT <= 0) this.health.reset();
    }
  }
}

function makeLabel(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(20,18,14,0.75)';
  g.fillRect(0, 0, 256, 48);
  g.fillStyle = '#f1ead8';
  g.font = 'bold 22px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 25);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  s.scale.set(1.4, 0.26, 1);
  return s;
}

/**
 * Firing range beside the distance markers (x≈60, marker posts every 25 m down -Z).
 * Firing line at z = 0, lanes x = 63…80.
 */
export class TargetRange {
  readonly firingLine = new THREE.Vector3(70, 0, 4);
  private dummies: Dummy[] = [];
  private plates: Plate[] = [];
  private rig: ArmorRig;

  constructor(scene: THREE.Scene, physics: Physics, registry: DamageRegistry) {
    // Firing line mat
    const mat = new THREE.Mesh(new THREE.BoxGeometry(18, 0.05, 2), new THREE.MeshStandardMaterial({ color: '#8a3b22', roughness: 0.9 }));
    mat.position.set(71, 0.025, 1);
    mat.receiveShadow = true;
    scene.add(mat);

    const d = (x: number, z: number, hp: number, shield: number, label: string) => {
      const dummy = new Dummy(scene, physics, registry, new THREE.Vector3(x, 0, z), hp, shield, label);
      this.dummies.push(dummy);
      return dummy;
    };
    d(64, -10, 100, 0, '10 m');
    d(67, -25, 100, 0, '25 m');
    d(70, -50, 100, 50, '50 m · shield');
    d(73, -75, 100, 0, '75 m');
    d(76, -100, 150, 50, '100 m · shield');
    d(70, -30, 100, 0, 'MOVER').setStrafe(4, 1.4);
    // Close-quarters cluster (chain lightning / shotgun tests)
    d(78, -8, 80, 0, 'CQB');
    d(79.5, -9, 80, 0, 'CQB');
    d(77, -10.5, 80, 0, 'CQB');

    for (const [z, size] of [[-125, 1.0], [-150, 1.2], [-175, 1.4], [-200, 1.6]] as const) {
      this.plates.push(new Plate(scene, physics, registry, new THREE.Vector3(66, 1.8, z), size));
    }
    this.rig = new ArmorRig(scene, physics, registry, new THREE.Vector3(74, 0.6, -40));
  }

  /** Fixed step (movers). */
  step(): void {
    for (const d of this.dummies) d.step(FIXED_DT);
  }

  update(dt: number): void {
    for (const d of this.dummies) d.update(dt);
    for (const p of this.plates) p.update(dt);
    this.rig.update(dt);
  }
}
