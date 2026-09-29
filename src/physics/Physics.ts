import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { FIXED_DT } from '../core/Time';

export { RAPIER };

/** Collision group bits (membership << 16 | filter). */
export const Groups = {
  WORLD: 1 << 0,
  PLAYER: 1 << 1,
  BOT: 1 << 2,
  PROJECTILE: 1 << 3,
  TRIGGER: 1 << 4,
  DEBRIS: 1 << 5,
} as const;

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

export function interactionGroups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

export class Physics {
  world!: RAPIER.World;
  private debugLines: THREE.LineSegments | null = null;
  /** Dynamic body ↔ mesh pairs synced after each step. */
  private synced: { body: RAPIER.RigidBody; mesh: THREE.Object3D }[] = [];

  async init(): Promise<void> {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_DT;
  }

  step(): void {
    this.world.step();
  }

  syncMeshes(): void {
    for (const { body, mesh } of this.synced) {
      const t = body.translation();
      const r = body.rotation();
      mesh.position.set(t.x, t.y, t.z);
      mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  // ---------------------------------------------------------------- builders

  addStaticBox(pos: THREE.Vector3, half: THREE.Vector3, rot?: THREE.Quaternion): RAPIER.Collider {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation(rot ? { x: rot.x, y: rot.y, z: rot.z, w: rot.w } : { x: 0, y: 0, z: 0, w: 1 }),
    );
    return this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setCollisionGroups(
        interactionGroups(Groups.WORLD, 0xffff),
      ),
      body,
    );
  }

  addDynamicBox(mesh: THREE.Mesh, half: THREE.Vector3, density = 1): RAPIER.RigidBody {
    const p = mesh.position;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z));
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
        .setDensity(density)
        .setCollisionGroups(interactionGroups(Groups.DEBRIS, 0xffff)),
      body,
    );
    this.synced.push({ body, mesh });
    return body;
  }

  addStaticTrimesh(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): RAPIER.Collider {
    const g = geometry.clone().applyMatrix4(matrix);
    const verts = new Float32Array(g.attributes.position.array);
    const idx = g.index
      ? new Uint32Array(g.index.array)
      : Uint32Array.from({ length: verts.length / 3 }, (_, i) => i);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    return this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(verts, idx).setCollisionGroups(interactionGroups(Groups.WORLD, 0xffff)),
      body,
    );
  }

  // ---------------------------------------------------------------- queries

  raycast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
    exclude?: RAPIER.Collider,
  ): { point: THREE.Vector3; normal: THREE.Vector3; distance: number; collider: RAPIER.Collider } | null {
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, undefined, exclude);
    if (!hit) return null;
    const point = origin.clone().addScaledVector(dir, hit.timeOfImpact);
    return {
      point,
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      distance: hit.timeOfImpact,
      collider: hit.collider,
    };
  }

  /** Sweep a sphere; returns hit distance along dir or null. */
  sphereCast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    radius: number,
    maxDist: number,
    exclude?: RAPIER.Collider,
  ): number | null {
    const hit = this.world.castShape(
      origin,
      IDENTITY,
      dir,
      new RAPIER.Ball(radius),
      0,
      maxDist,
      true,
      undefined,
      undefined,
      exclude,
    );
    return hit ? hit.time_of_impact : null;
  }

  /** True if a vertical capsule centred at pos overlaps nothing (ignoring exclude). */
  capsuleFree(pos: THREE.Vector3, halfHeight: number, radius: number, exclude?: RAPIER.Collider): boolean {
    const hit = this.world.intersectionWithShape(
      pos,
      IDENTITY,
      new RAPIER.Capsule(halfHeight, radius),
      undefined,
      interactionGroups(0xffff, Groups.WORLD | Groups.DEBRIS),
      exclude,
    );
    return hit === null;
  }

  // ---------------------------------------------------------------- debug

  setDebug(scene: THREE.Scene, on: boolean): void {
    if (on && !this.debugLines) {
      this.debugLines = new THREE.LineSegments(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ vertexColors: true, depthTest: true }),
      );
      this.debugLines.frustumCulled = false;
      scene.add(this.debugLines);
    } else if (!on && this.debugLines) {
      scene.remove(this.debugLines);
      this.debugLines.geometry.dispose();
      this.debugLines = null;
    }
  }

  updateDebug(): void {
    if (!this.debugLines) return;
    const { vertices, colors } = this.world.debugRender();
    const g = this.debugLines.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  }
}
