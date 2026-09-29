import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RAPIER, Groups, interactionGroups, type Physics } from '../physics/Physics';
import type { Heightmap } from './Heightmap';
import type { MapDef } from './MapDef';
import type { GenResult } from './MapGen';
import { hash2 } from './Noise';
import { triplanarMaterial } from './Materials';
import { NavObstacles } from '../ai/NavObstacles';

const CELL = 256;
const VIEW_DIST = 1000;
const SHADOW_DIST = 140;
type Kind = 'pine' | 'dead' | 'broad' | 'bush' | 'rock';

function colored(g: THREE.BufferGeometry, color: THREE.ColorRepresentation, jitter = 0): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  const c = new THREE.Color(color);
  const cols = new Float32Array(ng.attributes.position.count * 3);
  for (let i = 0; i < ng.attributes.position.count; i += 3) {
    const k = 1 + (Math.random() - 0.5) * jitter;
    for (let v = 0; v < 3; v++) cols.set([c.r * k, c.g * k, c.b * k], (i + v) * 3);
  }
  ng.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return ng;
}

function pineGeometry(): THREE.BufferGeometry {
  const parts = [colored(new THREE.CylinderGeometry(0.16, 0.3, 4, 6).translate(0, 2, 0), '#4a3626')];
  const tiers = [
    [2.4, 3.6, 2.6],
    [1.9, 3.2, 4.6],
    [1.4, 2.8, 6.4],
    [0.8, 2.2, 8.0],
  ];
  for (const [r, h, y] of tiers) parts.push(colored(new THREE.ConeGeometry(r, h, 7).translate(0, y, 0), '#2f4a2c', 0.25));
  return mergeGeometries(parts)!;
}

function deadGeometry(): THREE.BufferGeometry {
  const parts = [colored(new THREE.CylinderGeometry(0.12, 0.28, 7, 5).translate(0, 3.5, 0), '#5a5046')];
  for (const [ry, rz, y, l] of [[0, 0.9, 3.5, 2.4], [2.1, 0.8, 4.6, 2], [4.0, 1.0, 5.4, 1.6], [1.0, 0.7, 2.6, 1.8]]) {
    const b = new THREE.CylinderGeometry(0.05, 0.1, l, 4).translate(0, l / 2, 0).rotateZ(rz).rotateY(ry).translate(0, y, 0);
    parts.push(colored(b, '#5a5046'));
  }
  return mergeGeometries(parts)!;
}

function broadGeometry(): THREE.BufferGeometry {
  const parts = [colored(new THREE.CylinderGeometry(0.18, 0.3, 4.2, 6).translate(0, 2.1, 0), '#4d3b2a')];
  for (const [x, y, z, r] of [[0, 5.2, 0, 2.4], [1.2, 4.6, 0.6, 1.7], [-1.1, 4.8, -0.4, 1.8], [0.2, 6.3, -0.3, 1.5]]) {
    parts.push(colored(new THREE.IcosahedronGeometry(r, 0).translate(x, y, z), '#4f6a34', 0.3));
  }
  return mergeGeometries(parts)!;
}

function bushGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    colored(new THREE.IcosahedronGeometry(0.9, 0).scale(1.2, 0.7, 1.2).translate(0, 0.45, 0), '#4a5e30', 0.3),
    colored(new THREE.IcosahedronGeometry(0.6, 0).scale(1, 0.8, 1).translate(0.6, 0.5, 0.3), '#556a36', 0.3),
  ])!;
}

function rockGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i);
    const k = 0.75 + hash2(Math.round(v.x * 10), Math.round(v.z * 10 + v.y * 7), seed) * 0.5;
    v.multiplyScalar(k);
    v.y *= 0.65;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

interface Placement {
  kind: Kind;
  m: THREE.Matrix4;
}

/**
 * Scatters trees, bushes and boulders from forest zones + sparse fill, respecting
 * roads/pads/water/slopes. Instanced per 256 m cell for frustum + distance culling.
 */
export class Vegetation {
  private cells: { center: THREE.Vector3; group: THREE.Group }[] = [];
  count = 0;

  constructor(scene: THREE.Scene, physics: Physics, hm: Heightmap, def: MapDef, gen: GenResult) {
    const geos: Record<Kind, THREE.BufferGeometry> = {
      pine: pineGeometry(),
      dead: deadGeometry(),
      broad: broadGeometry(),
      bush: bushGeometry(),
      rock: rockGeometry(def.seed),
    };
    const foliage = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    const rockMat = triplanarMaterial('rock_face', { scale: 4, color: '#b8b2a8' });
    const mats: Record<Kind, THREE.Material> = { pine: foliage, dead: foliage, broad: foliage, bush: foliage, rock: rockMat };

    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const groups = interactionGroups(Groups.WORLD, 0xffff);
    const byCell = new Map<string, Placement[]>();
    const add = (kind: Kind, x: number, y: number, z: number, scale: number, rotY: number, tiltX = 0) => {
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(tiltX, rotY, 0)),
        kind === 'rock' ? new THREE.Vector3(scale * 1.3, scale, scale) : new THREE.Vector3(scale, scale, scale),
      );
      const key = `${Math.floor((x + hm.half) / CELL)},${Math.floor((z + hm.half) / CELL)}`;
      let list = byCell.get(key);
      if (!list) byCell.set(key, (list = []));
      list.push({ kind, m });
      this.count++;
      // Colliders: trunks for trees, squashed balls for rocks
      if (kind === 'pine' || kind === 'dead' || kind === 'broad') {
        physics.world.createCollider(RAPIER.ColliderDesc.cylinder(2 * scale, 0.28 * scale).setTranslation(x, y + 2 * scale, z).setCollisionGroups(groups), body);
        NavObstacles.addCylinder(x, z, y, y + 4 * scale, 0.28 * scale);
      } else if (kind === 'rock' && scale > 0.6) {
        physics.world.createCollider(RAPIER.ColliderDesc.ball(scale * 0.85).setTranslation(x, y + scale * 0.1, z).setCollisionGroups(groups), body);
        NavObstacles.addCylinder(x, z, y - scale * 0.75, y + scale * 0.95, scale * 0.85);
      }
    };

    const clearAt = (x: number, z: number) => {
      const ix = Math.round((x + hm.half) / hm.cell);
      const iz = Math.round((z + hm.half) / hm.cell);
      return gen.clear[iz * hm.n + ix] === 1;
    };

    // Jittered grid scatter, 5 m cells
    const step = 5;
    const edge = hm.half - 30;
    for (let z = -edge; z < edge; z += step) {
      for (let x = -edge; x < edge; x += step) {
        const gx = Math.round(x / step);
        const gz = Math.round(z / step);
        const px = x + (hash2(gx, gz, 1) - 0.5) * step;
        const pz = z + (hash2(gx, gz, 2) - 0.5) * step;
        if (clearAt(px, pz)) continue;
        let density = def.sparseTrees;
        let forestKind: 'pine' | 'dead' | 'mixed' | null = null;
        for (const f of def.forests) {
          const d = Math.hypot(px - f.center[0], pz - f.center[1]);
          if (d < f.radius) {
            const k = 1 - (d / f.radius) ** 2;
            if (f.density * k > density) {
              density = f.density * k;
              forestKind = f.kind;
            }
          }
        }
        const roll = hash2(gx, gz, 3);
        const y = hm.sample(px, pz);
        const rockiness = hm.splatAt(px, pz, 2);
        if (roll < (density * step * step) / 1000) {
          const kind: Kind =
            forestKind === 'dead' ? 'dead' : forestKind === 'mixed' ? (hash2(gx, gz, 4) < 0.5 ? 'broad' : 'pine') : forestKind === 'pine' ? 'pine' : hash2(gx, gz, 4) < 0.6 ? 'broad' : 'dead';
          add(kind, px, y - 0.2, pz, 0.75 + hash2(gx, gz, 5) * 0.6, hash2(gx, gz, 6) * 6.28);
        } else if (roll > 0.992 - rockiness * 0.04) {
          add('rock', px, y - 0.3, pz, 0.5 + hash2(gx, gz, 7) * 2.2 * (0.5 + rockiness), hash2(gx, gz, 8) * 6.28, hash2(gx, gz, 9) * 0.4);
        } else if (roll > 0.975 && roll < 0.985 && forestKind) {
          add('bush', px, y, pz, 0.7 + hash2(gx, gz, 10) * 0.8, hash2(gx, gz, 11) * 6.28);
        }
      }
    }

    // Build instanced meshes per cell × kind
    for (const [key, list] of byCell) {
      const [cx, cz] = key.split(',').map(Number);
      const group = new THREE.Group();
      const center = new THREE.Vector3(-hm.half + (cx + 0.5) * CELL, 0, -hm.half + (cz + 0.5) * CELL);
      for (const kind of Object.keys(geos) as Kind[]) {
        const items = list.filter((p) => p.kind === kind);
        if (!items.length) continue;
        const im = new THREE.InstancedMesh(geos[kind], mats[kind], items.length);
        items.forEach((p, i) => im.setMatrixAt(i, p.m));
        im.castShadow = kind !== 'bush';
        im.userData.canCast = kind !== 'bush';
        im.receiveShadow = true;
        im.computeBoundingSphere();
        group.add(im);
      }
      scene.add(group);
      this.cells.push({ center, group });
    }
  }

  update(camPos: THREE.Vector3): void {
    for (const c of this.cells) {
      const d = Math.hypot(c.center.x - camPos.x, c.center.z - camPos.z) - CELL * 0.7;
      c.group.visible = d < VIEW_DIST;
      // Only nearby cells cast shadows (casters are re-drawn once per shadow cascade)
      const cast = d < SHADOW_DIST;
      if (c.group.userData.cast !== cast) {
        c.group.userData.cast = cast;
        c.group.children.forEach((m) => (m.castShadow = cast && m.userData.canCast !== false));
      }
    }
  }
}
