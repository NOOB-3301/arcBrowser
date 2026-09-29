import * as THREE from 'three';

/**
 * W4 placeholder models for the Stalker and Colossus. One factory per unit so the
 * real models can be swapped in without touching the AI: keep the returned
 * interface (named parts the AI animates) and replace the geometry.
 */

const hull = (c = '#4b5157') => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.75 });
const plate = (c = '#8b8f86') => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, metalness: 0.6 });
const glow = (c = '#ff4a1a', i = 2.2) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: i, roughness: 0.3 });
const beamMat = (c: string) =>
  new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });

function mesh(g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.castShadow = true;
  parent.add(o);
  return o;
}

const _up = new THREE.Vector3(0, 1, 0);
const _d = new THREE.Vector3();

/** Stretch a unit-height (Y) mesh between two points in its parent's space. */
export function placeBetween(o: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3): void {
  _d.subVectors(b, a);
  const len = _d.length();
  o.position.copy(a).addScaledVector(_d, 0.5);
  if (len > 1e-5) o.quaternion.setFromUnitVectors(_up, _d.divideScalar(len));
  o.scale.set(1, len, 1);
}

/** Beam: unit cylinder along Y, stretched with placeBetween. */
function beam(color: string, radius: number): { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial } {
  const mat = beamMat(color);
  const g = new THREE.CylinderGeometry(radius, radius, 1, 8, 1, true);
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  m.visible = false;
  m.renderOrder = 2;
  return { mesh: m, mat };
}

export interface LegParts {
  upper: THREE.Mesh;
  lower: THREE.Mesh;
  knee: THREE.Mesh;
  foot: THREE.Mesh;
  kneeMat: THREE.MeshStandardMaterial;
}

function leg(parent: THREE.Object3D, thick: number, mat: THREE.Material, footMat: THREE.Material, kneeR: number, kneeColor: string): LegParts {
  const upper = mesh(new THREE.BoxGeometry(thick, 1, thick), mat, parent);
  const lower = mesh(new THREE.CylinderGeometry(thick * 0.45, thick * 0.7, 1, 8), mat, parent);
  const kneeMat = glow(kneeColor, 1.6);
  const knee = mesh(new THREE.SphereGeometry(kneeR, 12, 10), kneeMat, parent);
  const foot = mesh(new THREE.CylinderGeometry(thick * 0.9, thick * 1.2, thick * 0.5, 10), footMat, parent);
  return { upper, lower, knee, foot, kneeMat };
}

// ------------------------------------------------------------------ stalker

export interface StalkerModel {
  /** World-space root; legs live in world space (IK), the hull follows the body. */
  root: THREE.Group;
  hull: THREE.Group;
  eyeMat: THREE.MeshStandardMaterial;
  legs: LegParts[];
  /** Hip anchors in hull-local space (FL, FR, BL, BR). */
  hips: THREE.Vector3[];
  laser: THREE.Mesh;
  laserMat: THREE.MeshBasicMaterial;
  /** Muzzle in hull-local space. */
  muzzle: THREE.Vector3;
  mats: THREE.MeshStandardMaterial[];
}

/** Quadruped walker (~3 m): armoured hull, sensor head with a laser emitter, four jointed legs. */
export function stalkerModel(): StalkerModel {
  const root = new THREE.Group();
  const hullGroup = new THREE.Group();
  root.add(hullGroup);
  const h = hull('#3d4247');
  const p = plate('#b9b6a8');
  const stripe = plate('#d08a1c');
  const eyeMat = glow('#ff3a1a', 2.5);
  // Hull: armoured carapace (forward = -z)
  const body = mesh(new THREE.SphereGeometry(1, 16, 12), h, hullGroup, 0, 0, 0.1);
  body.scale.set(0.95, 0.55, 1.35);
  mesh(new THREE.BoxGeometry(1.5, 0.22, 2.1), p, hullGroup, 0, 0.5, 0.2);
  mesh(new THREE.BoxGeometry(1.2, 0.18, 1.2), p, hullGroup, 0, 0.66, 0.35).rotation.x = -0.08;
  mesh(new THREE.BoxGeometry(1.56, 0.08, 0.14), stripe, hullGroup, 0, 0.62, -0.55);
  mesh(new THREE.BoxGeometry(1.56, 0.08, 0.14), stripe, hullGroup, 0, 0.62, 0.95);
  // Rear heat sink fins
  for (let i = -2; i <= 2; i++) mesh(new THREE.BoxGeometry(0.05, 0.35, 0.5), h, hullGroup, i * 0.18, 0.45, 1.35);
  // Sensor head
  const head = new THREE.Group();
  head.position.set(0, 0.15, -1.25);
  hullGroup.add(head);
  mesh(new THREE.BoxGeometry(0.9, 0.5, 0.7), h, head);
  mesh(new THREE.BoxGeometry(0.95, 0.12, 0.75), p, head, 0, 0.3, 0);
  mesh(new THREE.SphereGeometry(0.16, 12, 10), eyeMat, head, 0, 0.02, -0.36);
  for (const x of [-0.28, 0.28]) mesh(new THREE.SphereGeometry(0.07, 8, 6), eyeMat, head, x, 0.1, -0.34);
  mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.7, 8), h, head, 0, -0.22, -0.55).rotation.x = Math.PI / 2;
  mesh(new THREE.BoxGeometry(0.04, 0.6, 0.04), h, head, 0.3, 0.55, 0.2);
  const legMat = hull('#2f3337');
  const footMat = plate('#6d6a60');
  const legs: LegParts[] = [];
  for (let i = 0; i < 4; i++) legs.push(leg(root, 0.34, legMat, footMat, 0.24, '#ffae20'));
  const hips = [
    new THREE.Vector3(-0.85, -0.05, -0.75),
    new THREE.Vector3(0.85, -0.05, -0.75),
    new THREE.Vector3(-0.85, -0.05, 0.95),
    new THREE.Vector3(0.85, -0.05, 0.95),
  ];
  for (const hp of hips) mesh(new THREE.SphereGeometry(0.24, 10, 8), p, hullGroup, hp.x, hp.y, hp.z);
  const b = beam('#ff2a1a', 0.05);
  root.add(b.mesh);
  return { root, hull: hullGroup, eyeMat, legs, hips, laser: b.mesh, laserMat: b.mat, muzzle: new THREE.Vector3(0, -0.07, -1.9), mats: [h, p, legMat] };
}

// ------------------------------------------------------------------ colossus

export interface ColossusModel {
  root: THREE.Group;
  hull: THREE.Group;
  head: THREE.Group;
  legs: LegParts[];
  hips: THREE.Vector3[];
  core: THREE.Mesh;
  coreMat: THREE.MeshStandardMaterial;
  /** Armour plates over the core (hull-local), in the same order as the AI's plate colliders. */
  plates: THREE.Mesh[];
  /** Plate centres/sizes in hull-local space (collider layout). */
  plateLayout: { pos: THREE.Vector3; size: THREE.Vector3 }[];
  eyeMat: THREE.MeshStandardMaterial;
  laser: THREE.Mesh;
  laserMat: THREE.MeshBasicMaterial;
  /** Laser muzzle in head-local space. */
  muzzle: THREE.Vector3;
  /** Mortar tube mouths in hull-local space. */
  tubes: THREE.Vector3[];
  mats: THREE.MeshStandardMaterial[];
}

/**
 * Towering 4-legged siege walker (~13 m). Front armour plates hide a glowing
 * core; a turret head carries the heavy laser and a mortar pod sits on the back.
 */
export function colossusModel(): ColossusModel {
  const root = new THREE.Group();
  const hullGroup = new THREE.Group();
  root.add(hullGroup);
  const h = hull('#353a3f');
  const p = plate('#9b948a');
  const rust = plate('#7a4a32');
  const stripe = plate('#d6a020');
  const coreMat = glow('#ffc040', 3);
  const eyeMat = glow('#ff3020', 3);
  // Torso: stacked blocks, forward = -z
  mesh(new THREE.BoxGeometry(6.5, 3.2, 8.5), h, hullGroup);
  mesh(new THREE.BoxGeometry(7.1, 0.6, 9.1), p, hullGroup, 0, 1.8, 0);
  mesh(new THREE.BoxGeometry(5.5, 1.2, 7.5), rust, hullGroup, 0, -2.1, 0.2);
  for (const x of [-3.3, 3.3]) mesh(new THREE.BoxGeometry(0.6, 2.6, 7.8), p, hullGroup, x, 0, 0.2);
  mesh(new THREE.BoxGeometry(7.2, 0.25, 0.3), stripe, hullGroup, 0, 2.2, -4.5);
  // Core housing (front): recessed socket + core
  mesh(new THREE.BoxGeometry(3.4, 3, 0.8), h, hullGroup, 0, -0.2, -4.4);
  const core = mesh(new THREE.SphereGeometry(0.95, 20, 14), coreMat, hullGroup, 0, -0.2, -4.75);
  // Plates: 2×2 grid in front of the core
  const plateLayout: { pos: THREE.Vector3; size: THREE.Vector3 }[] = [];
  const plates: THREE.Mesh[] = [];
  for (const [x, y] of [[-0.8, 0.55], [0.8, 0.55], [-0.8, -0.95], [0.8, -0.95]]) {
    const pos = new THREE.Vector3(x, y, -5.35);
    const size = new THREE.Vector3(1.55, 1.45, 0.4);
    plateLayout.push({ pos, size });
    const m = mesh(new THREE.BoxGeometry(size.x, size.y, size.z), plate('#c9c2b2'), hullGroup, pos.x, pos.y, pos.z);
    m.rotation.set(-y * 0.08, -x * 0.1, 0);
    plates.push(m);
    mesh(new THREE.BoxGeometry(size.x * 0.9, 0.1, 0.05), stripe, m, 0, size.y / 2 - 0.15, -0.21);
  }
  // Mortar pod on the back
  const tubes: THREE.Vector3[] = [];
  mesh(new THREE.BoxGeometry(4, 1.6, 3), rust, hullGroup, 0, 2.8, 2.4);
  for (let i = 0; i < 6; i++) {
    const x = -1.4 + (i % 3) * 1.4;
    const z = 1.8 + Math.floor(i / 3) * 1.2;
    const t = mesh(new THREE.CylinderGeometry(0.32, 0.36, 1.6, 10), h, hullGroup, x, 4, z);
    t.rotation.x = 0.25;
    tubes.push(new THREE.Vector3(x, 4.8, z - 0.2));
  }
  // Turret head with the heavy laser
  const head = new THREE.Group();
  head.position.set(0, 2.9, -1.8);
  hullGroup.add(head);
  mesh(new THREE.BoxGeometry(3, 1.6, 3), h, head);
  mesh(new THREE.BoxGeometry(3.2, 0.3, 3.2), p, head, 0, 0.9, 0);
  mesh(new THREE.BoxGeometry(2.2, 0.35, 0.2), eyeMat, head, 0, 0.2, -1.52);
  mesh(new THREE.CylinderGeometry(0.28, 0.4, 3, 12), h, head, 0, -0.2, -2.6).rotation.x = Math.PI / 2;
  mesh(new THREE.TorusGeometry(0.42, 0.1, 8, 16), eyeMat, head, 0, -0.2, -3.9);
  for (const x of [-1.2, 1.2]) mesh(new THREE.BoxGeometry(0.08, 2.6, 0.08), h, head, x, 2, 1);
  // Legs
  const legMat = hull('#2b2f33');
  const footMat = plate('#5d5a52');
  const legs: LegParts[] = [];
  for (let i = 0; i < 4; i++) legs.push(leg(root, 1.1, legMat, footMat, 0.8, '#ff7a20'));
  const hips = [
    new THREE.Vector3(-3.6, -0.6, -3.2),
    new THREE.Vector3(3.6, -0.6, -3.2),
    new THREE.Vector3(-3.6, -0.6, 3.2),
    new THREE.Vector3(3.6, -0.6, 3.2),
  ];
  for (const hp of hips) mesh(new THREE.SphereGeometry(1.1, 12, 10), p, hullGroup, hp.x, hp.y, hp.z);
  const b = beam('#ff3a20', 0.35);
  root.add(b.mesh);
  return {
    root, hull: hullGroup, head, legs, hips, core, coreMat, plates, plateLayout, eyeMat,
    laser: b.mesh, laserMat: b.mat, muzzle: new THREE.Vector3(0, -0.2, -4.1), tubes, mats: [h, p, rust, legMat],
  };
}

/** Pulsing ground ring used to telegraph artillery impacts. */
export function strikeMarker(radius: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(radius * 0.82, radius, 40),
    new THREE.MeshBasicMaterial({ color: '#ff3020', transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  );
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 3;
  const inner = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.82, 32),
    new THREE.MeshBasicMaterial({ color: '#ff2010', transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }),
  );
  m.add(inner);
  return m;
}
