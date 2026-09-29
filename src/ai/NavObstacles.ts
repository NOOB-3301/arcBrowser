import type * as THREE from 'three';

/** Static obstacle footprints recorded while the world is built; rasterised into the nav grid. */
export type Obstacle =
  | { kind: 'box'; pos: THREE.Vector3; half: THREE.Vector3; rot: THREE.Quaternion }
  | { kind: 'cyl'; x: number; z: number; y0: number; y1: number; r: number };

export const NavObstacles = {
  list: [] as Obstacle[],
  addBox(pos: THREE.Vector3, half: THREE.Vector3, rot: THREE.Quaternion): void {
    this.list.push({ kind: 'box', pos: pos.clone(), half: half.clone(), rot: rot.clone() });
  },
  addCylinder(x: number, z: number, y0: number, y1: number, r: number): void {
    this.list.push({ kind: 'cyl', x, z, y0, y1, r });
  },
  clear(): void {
    this.list.length = 0;
  },
};
