import * as THREE from 'three';
import type { Physics } from '../physics/Physics';
import type { DamageRegistry } from '../combat/Damage';
import { TestArena } from './TestArena';
import { TargetRange } from './TargetRange';
import { Traversal } from './Traversal';
import { DayNight } from './DayNight';
import type { GameWorld } from './World';

/** Greybox test arena + firing range (movement/combat tuning). Load with ?map=arena. */
export class ArenaWorld implements GameWorld {
  readonly id = 'arena';
  readonly name = 'Test Arena';
  readonly traversal = new Traversal();
  readonly spawn: THREE.Vector3;
  readonly dayNight: DayNight;
  readonly spots: Record<string, THREE.Vector3>;
  private range: TargetRange;

  constructor(scene: THREE.Scene, physics: Physics, registry: DamageRegistry, renderer: THREE.WebGLRenderer) {
    this.dayNight = new DayNight(scene, renderer);
    this.dayNight.fog.near = 80;
    this.dayNight.fog.far = 900;
    const arena = new TestArena(scene, physics, this.traversal);
    arena.build();
    this.spawn = arena.spawn.clone().setY(0);
    this.range = new TargetRange(scene, physics, registry);
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    this.spots = {
      Spawn: v(0, 0, 8), Range: v(70, 0, 4), Ledges: v(-10, 0, -4), Ramps: v(21, 0, -2), Stairs: v(-30, 0, 13),
      'Vault walls': v(-9, 0, 50), 'Slide hill (top)': v(-70, 5, 22), Ladder: v(-45, 0, -23), Corridor: v(41.5, 0, 12),
    };
  }

  step(): void {
    this.range.step();
  }

  update(dt: number, _camera: THREE.Camera, focus: THREE.Vector3): void {
    this.range.update(dt);
    this.dayNight.update(focus);
  }

  stats(): Record<string, number> {
    return {};
  }
}
