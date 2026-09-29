import * as THREE from 'three';
import { RAPIER, Groups, interactionGroups, type Physics } from '../physics/Physics';
import type { MapDef } from './MapDef';
import { generateTerrain, type GenResult } from './MapGen';
import { Terrain } from './Terrain';
import { Water } from './Water';
import { Vegetation } from './Vegetation';
import { Foliage } from './Foliage';
import { Kit } from './BuildingKit';
import {
  buildBridges, buildContainers, buildDam, buildFarm, buildPumping, buildPylons, buildRadio, buildTown, buildVillage, buildWrecks,
} from './POIs';
import { Extracts } from './Extracts';
import { Traversal } from './Traversal';
import { DayNight } from './DayNight';
import { texturesReady } from './Materials';
import type { Heightmap } from './Heightmap';
import type { GameWorld, MapInfo } from './World';

const POI_VIEW_DIST = 1300;

/**
 * Generated large map: heightfield terrain + LOD, water, POIs from the building
 * kit, vegetation, GPU grass, extraction beacons. Everything is static; the
 * whole terrain is one Rapier heightfield.
 */
export class MapWorld implements GameWorld {
  readonly id: string;
  readonly name: string;
  readonly traversal = new Traversal();
  readonly spawn = new THREE.Vector3();
  readonly dayNight: DayNight;
  readonly spots: Record<string, THREE.Vector3> = {};
  map!: MapInfo;
  private hm!: Heightmap;
  private gen!: GenResult;
  private terrain!: Terrain;
  private water!: Water;
  private vegetation!: Vegetation;
  private foliage!: Foliage;
  private extracts!: Extracts;
  private poiGroups: { group: THREE.Object3D; center: THREE.Vector3; radius: number }[] = [];
  private timings: Record<string, number> = {};

  constructor(private scene: THREE.Scene, private physics: Physics, renderer: THREE.WebGLRenderer, private def: MapDef) {
    this.id = def.id;
    this.name = def.name;
    this.dayNight = new DayNight(scene, renderer);
  }

  async init(progress: (msg: string) => void): Promise<void> {
    const t = (label: string, fn: () => void) => {
      const s = performance.now();
      fn();
      this.timings[label] = Math.round(performance.now() - s);
    };
    const def = this.def;
    progress('Shaping terrain…');
    await frame();
    t('terrain-gen', () => {
      this.gen = generateTerrain(def);
      this.hm = this.gen.hm;
    });
    const hm = this.hm;

    progress('Building terrain meshes…');
    await frame();
    t('terrain-mesh', () => {
      this.terrain = new Terrain(this.scene, hm);
      this.createHeightfield();
      this.createBounds();
      this.water = new Water(this.scene, def);
    });

    progress('Raising structures…');
    await frame();
    t('pois', () => this.buildPOIs());

    progress('Growing forests…');
    await frame();
    t('vegetation', () => {
      this.vegetation = new Vegetation(this.scene, this.physics, hm, def, this.gen);
      this.foliage = new Foliage(this.scene, hm, this.gen);
    });
    this.extracts = new Extracts(this.scene, hm, def.extracts);
    this.map = { def, hm, gen: this.gen, extracts: this.extracts.points };

    // Spawn + debug teleports
    const [sx, sz] = def.spawns[Math.floor(Math.random() * def.spawns.length)];
    this.spawn.set(sx, hm.sample(sx, sz) + 0.2, sz);
    def.spawns.forEach(([x, z], i) => (this.spots[`Spawn ${i + 1}`] = new THREE.Vector3(x, hm.sample(x, z) + 0.2, z)));
    for (const p of def.pois) this.spots[p.name] = new THREE.Vector3(p.center[0], hm.sample(p.center[0], p.center[1]) + 1, p.center[1] + p.radius * 0.6);
    if (def.dam) this.spots['Ironvale Dam'] = new THREE.Vector3(70, def.dam.top + 0.5, def.dam.z);
    for (const e of this.extracts.points) this.spots[`⇪ ${e.def.name}`] = e.pos.clone().add(new THREE.Vector3(0, 0.5, 6));

    progress('Loading textures…');
    await texturesReady();
    this.terrain.prewarm(this.spawn);
  }

  private createHeightfield(): void {
    const hm = this.hm;
    const body = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.physics.world.createCollider(
      RAPIER.ColliderDesc.heightfield(hm.n - 1, hm.n - 1, hm.rapierHeights(), { x: hm.size, y: 1, z: hm.size }).setCollisionGroups(
        interactionGroups(Groups.WORLD, 0xffff),
      ),
      body,
    );
  }

  /** Invisible walls just inside the rim. */
  private createBounds(): void {
    const h = this.hm.half - 20;
    const body = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const groups = interactionGroups(Groups.WORLD, 0xffff);
    for (const [x, z, hx, hz] of [[0, -h, h, 1], [0, h, h, 1], [-h, 0, 1, h], [h, 0, 1, h]]) {
      this.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, 400, hz).setTranslation(x, 150, z).setCollisionGroups(groups), body);
    }
  }

  private buildPOIs(): void {
    const { def, hm, gen } = this;
    const padY = (cx: number, cz: number) => {
      const i = def.pads.findIndex((p) => p.center[0] === cx && p.center[1] === cz);
      return i >= 0 ? gen.padHeights[i] : hm.sample(cx, cz);
    };
    const add = (fn: (kit: Kit) => void, seed: number, center: THREE.Vector3, radius: number) => {
      const kit = new Kit(seed);
      fn(kit);
      const group = kit.build(this.scene, this.physics);
      this.poiGroups.push({ group, center, radius });
    };
    for (const poi of def.pois) {
      const c = new THREE.Vector3(poi.center[0], 0, poi.center[1]);
      const seed = poi.seed ?? poi.id.length * 97;
      switch (poi.kind) {
        case 'dam':
          add((k) => buildDam(k, def, hm), seed, c, poi.radius);
          break;
        case 'pumping':
          add((k) => buildPumping(k, poi, padY(poi.center[0], poi.center[1])), seed, c, poi.radius);
          break;
        case 'radio':
          add((k) => buildRadio(k, poi, padY(poi.center[0], poi.center[1])), seed, c, poi.radius);
          break;
        case 'village':
          add((k) => buildVillage(k, poi, hm, gen), seed, c, poi.radius);
          break;
        case 'town':
          add((k) => buildTown(k, poi, hm, gen), seed, c, poi.radius);
          break;
        case 'farm':
          add((k) => buildFarm(k, poi, hm), seed, c, poi.radius);
          break;
        case 'containers':
          add((k) => buildContainers(k, poi, padY(poi.center[0], poi.center[1])), seed, c, poi.radius);
          break;
      }
    }
    // Map-wide infrastructure (never distance-culled: long thin features)
    const infra = new Kit(def.seed);
    const cables = buildPylons(infra, def, hm);
    buildBridges(infra, def, hm, gen);
    buildWrecks(infra, gen);
    const g = infra.build(this.scene, this.physics);
    g.add(cables);
    this.poiGroups.push({ group: g, center: new THREE.Vector3(), radius: 1e6 });
  }

  heightAt(x: number, z: number): number {
    return this.hm.sample(x, z);
  }

  step(): void {}

  update(dt: number, camera: THREE.Camera, focus: THREE.Vector3): void {
    const cam = camera.position;
    this.terrain.update(cam);
    this.vegetation.update(cam);
    const dn = this.dayNight;
    this.foliage.update(dt, cam, dn.sun.color.clone().multiplyScalar(dn.sun.intensity * 0.35), dn.ambientColor, Math.max(0, dn.sunDir.y));
    this.water.update(dt, dn.sunDir, dn.sun.color, dn.skyColor);
    this.extracts.update(dt);
    dn.update(focus);
    for (const p of this.poiGroups) {
      p.group.visible = Math.hypot(p.center.x - cam.x, p.center.z - cam.z) - p.radius < POI_VIEW_DIST;
    }
  }

  stats(): Record<string, number> {
    return { ...this.timings, trees: this.vegetation.count, terrainTris: this.terrain.triangleEstimate };
  }
}

function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
