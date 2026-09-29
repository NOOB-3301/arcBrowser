import type * as THREE from 'three';
import type { Traversal } from './Traversal';
import type { DayNight } from './DayNight';
import type { MapDef } from './MapDef';
import type { Heightmap } from './Heightmap';
import type { GenResult } from './MapGen';
import type { ExtractPoint } from './Extracts';

/** Data the map UI / compass need about a generated map. */
export interface MapInfo {
  def: MapDef;
  hm: Heightmap;
  gen: GenResult;
  extracts: ExtractPoint[];
}

/** A playable space: test arena or a generated map. */
export interface GameWorld {
  readonly id: string;
  readonly name: string;
  readonly traversal: Traversal;
  readonly spawn: THREE.Vector3;
  readonly dayNight: DayNight;
  readonly map?: MapInfo;
  /** Named teleport spots for the debug menu. */
  readonly spots: Record<string, THREE.Vector3>;
  /** Terrain height (for fall-through recovery), if the world has terrain. */
  heightAt?(x: number, z: number): number;
  step(): void;
  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3): void;
  stats(): Record<string, number>;
}
