import * as THREE from 'three';
import { Assets, cloneMaterials } from '../../assets/Assets';
import type { AssetKey } from '../../assets/manifest';

const hull = () => new THREE.MeshStandardMaterial({ color: '#4b5157', roughness: 0.45, metalness: 0.75 });
const plate = () => new THREE.MeshStandardMaterial({ color: '#8b8f86', roughness: 0.5, metalness: 0.6 });
const glow = (c = '#ff4a1a') => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 2.2, roughness: 0.3 });

function mesh(g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.castShadow = true;
  parent.add(o);
  return o;
}

export interface TickModel {
  root: THREE.Group;
  legs: THREE.Object3D[];
  core: THREE.Mesh;
  coreMat: THREE.MeshStandardMaterial;
  mats: THREE.MeshStandardMaterial[];
}

/** Six-legged crawler with an exposed core on its back. */
function tickModelProcedural(): TickModel {
  const root = new THREE.Group();
  const h = hull();
  const p = plate();
  const coreMat = glow();
  const body = mesh(new THREE.SphereGeometry(0.42, 12, 8), h, root, 0, 0.32, 0);
  body.scale.set(1, 0.5, 1.25);
  mesh(new THREE.BoxGeometry(0.5, 0.08, 0.6), p, root, 0, 0.44, -0.05);
  const core = mesh(new THREE.SphereGeometry(0.12, 10, 8), coreMat, root, 0, 0.5, 0.15);
  mesh(new THREE.BoxGeometry(0.3, 0.05, 0.05), glow('#ffb020'), root, 0, 0.34, -0.52); // eye bar
  const legs: THREE.Group[] = [];
  for (let i = 0; i < 6; i++) {
    const side = i < 3 ? -1 : 1;
    const k = i % 3;
    const leg = new THREE.Group();
    leg.position.set(side * 0.3, 0.32, -0.3 + k * 0.3);
    leg.rotation.y = side * (Math.PI / 2) + (k - 1) * 0.5 * side;
    const upper = mesh(new THREE.BoxGeometry(0.05, 0.05, 0.4), h, leg, 0, 0.1, -0.18);
    upper.rotation.x = 0.5;
    const lower = mesh(new THREE.BoxGeometry(0.04, 0.4, 0.04), h, leg, 0, -0.08, -0.36);
    lower.rotation.x = -0.25;
    root.add(leg);
    legs.push(leg);
  }
  return { root, legs, core, coreMat, mats: [h, p] };
}

export interface WaspModel {
  root: THREE.Group;
  rotors: THREE.Object3D[];
  body: THREE.Object3D;
  mats: THREE.MeshStandardMaterial[];
  eye: THREE.MeshStandardMaterial;
}

/** Quad-rotor strike drone. Rotor hubs are weak points. */
function waspModelProcedural(): WaspModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const h = hull();
  const p = plate();
  const eye = glow();
  const core = mesh(new THREE.SphereGeometry(0.42, 14, 10), h, body);
  core.scale.set(1, 0.7, 1.3);
  mesh(new THREE.BoxGeometry(0.5, 0.1, 0.7), p, body, 0, 0.26, 0);
  mesh(new THREE.SphereGeometry(0.1, 10, 8), eye, body, 0, -0.02, -0.52);
  mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 6), h, body, 0, -0.25, -0.2).rotation.x = Math.PI / 2;
  const rotors: THREE.Object3D[] = [];
  const rotorMat = new THREE.MeshStandardMaterial({ color: '#222', transparent: true, opacity: 0.55, roughness: 0.4 });
  for (const [x, z] of [[-0.75, -0.6], [0.75, -0.6], [0.75, 0.6], [-0.75, 0.6]]) {
    const arm = mesh(new THREE.BoxGeometry(Math.hypot(x, z), 0.06, 0.08), h, body, x / 2, 0.08, z / 2);
    arm.rotation.y = -Math.atan2(z, x);
    mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.18, 8), p, body, x, 0.12, z);
    const r = mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.02, 16), rotorMat, body, x, 0.24, z);
    r.castShadow = false;
    rotors.push(r);
  }
  return { root, rotors, body, mats: [h, p], eye };
}

export interface SentinelModel {
  root: THREE.Group;
  head: THREE.Object3D;
  eyeMat: THREE.MeshStandardMaterial;
  laser: THREE.Line;
  laserMat: THREE.LineBasicMaterial;
  mats: THREE.MeshStandardMaterial[];
}

/** Tripod turret with a scanning laser eye. */
function sentinelModelProcedural(): SentinelModel {
  const root = new THREE.Group();
  const h = hull();
  const p = plate();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = mesh(new THREE.BoxGeometry(0.12, 1.8, 0.12), h, root, Math.cos(a) * 0.55, 0.8, Math.sin(a) * 0.55);
    leg.rotation.set(Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35);
  }
  mesh(new THREE.CylinderGeometry(0.35, 0.45, 0.35, 12), p, root, 0, 1.6, 0);
  const head = new THREE.Group();
  head.position.y = 2.05;
  root.add(head);
  mesh(new THREE.BoxGeometry(0.9, 0.55, 0.8), h, head);
  mesh(new THREE.BoxGeometry(0.95, 0.12, 0.85), p, head, 0, 0.3, 0);
  for (const x of [-0.18, 0.18]) mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.9, 8), h, head, x, -0.05, -0.75).rotation.x = Math.PI / 2;
  const eyeMat = glow('#ff7a20');
  mesh(new THREE.SphereGeometry(0.13, 12, 10), eyeMat, head, 0, 0.08, -0.42);
  const laserMat = new THREE.LineBasicMaterial({ color: '#ff9a40', transparent: true, opacity: 0.8 });
  const laser = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), laserMat);
  laser.frustumCulled = false;
  root.add(laser);
  return { root, head, eyeMat, laser, laserMat, mats: [h, p] };
}

// ---------------------------------------------------------------------------------------------
// GLB-backed factories (Blender-modelled ARC units, see CREDITS.md). Same shapes as the procedural
// stand-ins above, which remain as fallbacks if a GLB failed to load.

export interface ArcAsset {
  /** Wrapper group to position/rotate (the GLB's origin = unit origin on the ground, facing -Z). */
  root: THREE.Group;
  /** Every named node in the clone (e.g. `stalker_leg_fl_lower`, `colossus_plate_3`). */
  nodes: Record<string, THREE.Object3D>;
  /** Per-instance material clones by name: A_hull, A_plate, A_dark, A_joint, A_core, A_eye, A_blur. */
  mats: Record<string, THREE.MeshStandardMaterial>;
}

/** Clones an ARC GLB with per-instance materials and a name -> node index. Null if not loaded. */
export function arcAsset(key: AssetKey): ArcAsset | null {
  if (!Assets.has(key)) return null;
  const scene = Assets.clone(key);
  const root = new THREE.Group();
  root.add(scene);
  const mats: Record<string, THREE.MeshStandardMaterial> = {};
  for (const m of cloneMaterials(scene)) mats[m.name] = m;
  const nodes: Record<string, THREE.Object3D> = {};
  scene.traverse((o) => {
    if (o.name) nodes[o.name] = o;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      const blur = (mesh.material as THREE.MeshStandardMaterial).name === 'A_blur';
      mesh.castShadow = !blur;
      mesh.receiveShadow = !blur;
    }
  });
  // Worn-white ARC shell: brighter albedo, mostly dielectric paint so it doesn't read dark under the sky env.
  if (mats.A_hull) {
    mats.A_hull.color.setRGB(1, 0.98, 0.94);
    mats.A_hull.metalness = 0.08;
  }
  if (mats.A_plate) mats.A_plate.metalness = 0.1;
  if (mats.A_blur) {
    mats.A_blur.transparent = true;
    mats.A_blur.depthWrite = false;
  }
  return { root, nodes, mats };
}

const flashMats = (a: ArcAsset) => ['A_hull', 'A_plate', 'A_dark', 'A_joint'].map((n) => a.mats[n]).filter(Boolean);

/** Joint-style Euler order so `rotation.x` swings a limb in its own (yawed) frame. */
function asJoint(o: THREE.Object3D): THREE.Object3D {
  o.rotation.setFromQuaternion(o.quaternion, 'YXZ');
  return o;
}

/** Six-legged crawler with an exposed core on its back. */
export function tickModel(): TickModel {
  const a = arcAsset('arc_tick');
  if (!a) return tickModelProcedural();
  const legs = [0, 1, 2, 3, 4, 5].map((i) => asJoint(a.nodes[`tick_leg_${i}`]));
  const core = a.nodes.tick_core as THREE.Mesh;
  return { root: a.root, legs, core, coreMat: a.mats.A_core, mats: flashMats(a) };
}

/** Quad-rotor strike drone. Rotor hubs are weak points. */
export function waspModel(): WaspModel {
  const a = arcAsset('arc_wasp');
  if (!a) return waspModelProcedural();
  const rotors = [0, 1, 2, 3].map((i) => a.nodes[`wasp_rotor_${i}`]);
  return { root: a.root, rotors, body: a.nodes.wasp_body, mats: flashMats(a), eye: a.mats.A_eye };
}

/** Tripod turret with a scanning laser eye. */
export function sentinelModel(): SentinelModel {
  const a = arcAsset('arc_sentinel');
  if (!a) return sentinelModelProcedural();
  const head = a.nodes.sentinel_head;
  head.rotation.set(0, 0, 0, 'YXZ');
  const laserMat = new THREE.LineBasicMaterial({ color: '#ff9a40', transparent: true, opacity: 0.8 });
  const laser = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), laserMat);
  laser.frustumCulled = false;
  a.root.add(laser);
  return { root: a.root, head, eyeMat: a.mats.A_eye, laser, laserMat, mats: flashMats(a) };
}
