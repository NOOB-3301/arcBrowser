import type * as THREE from 'three';
import type { Physics } from '../physics/Physics';
import type { DamageRegistry } from '../combat/Damage';
import type { Ballistics } from '../weapons/Ballistics';
import type { Effects } from '../combat/Effects';
import type { NavGrid } from './NavGrid';
import type { Difficulty } from './Difficulty';
import type { Traversal } from '../world/Traversal';

/** Services shared by every bot. */
export interface AIContext {
  scene: THREE.Scene;
  physics: Physics;
  registry: DamageRegistry;
  ballistics: Ballistics;
  effects: Effects;
  nav: NavGrid;
  traversal: Traversal;
  difficulty: Difficulty;
  heightAt(x: number, z: number): number;
  /** Seconds since AI start. */
  time: number;
  /** Player position (AI LOD). */
  focus: THREE.Vector3;
  /** Points of interest bots roam between. */
  roamPoints: THREE.Vector3[];
  /** Extraction points (raider bots head here late). */
  extracts: THREE.Vector3[];
}
