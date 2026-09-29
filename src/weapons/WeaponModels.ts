import * as THREE from 'three';
import { RARITY, type Rarity, type WeaponDef } from './WeaponDefs';

/**
 * Procedural stand-in weapon meshes (replaced by Blender GLBs in M7).
 * Built along -Z (barrel forward). `userData.muzzle` marks the barrel tip.
 */
export function buildWeaponModel(def: WeaponDef, rarity: Rarity): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: '#2b2d2f', roughness: 0.55, metalness: 0.5 });
  const furniture = new THREE.MeshStandardMaterial({ color: '#4a4034', roughness: 0.8 });
  const accent = new THREE.MeshStandardMaterial({ color: RARITY[rarity].color, roughness: 0.5, emissive: RARITY[rarity].color, emissiveIntensity: 0.15 });
  const glow = new THREE.MeshStandardMaterial({ color: '#66e0ff', emissive: '#44ccff', emissiveIntensity: 1.5 });

  const box = (w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  const cyl = (r: number, len: number, m: THREE.Material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), m);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };

  let barrelEnd = -0.6;
  switch (def.cls) {
    case 'smg':
      box(0.07, 0.12, 0.38, body, 0, 0, -0.15);
      box(0.05, 0.16, 0.06, body, 0, -0.12, -0.12); // mag
      box(0.04, 0.1, 0.18, furniture, 0, -0.01, 0.12); // stock
      cyl(0.022, def.suppressed ? 0.28 : 0.12, body, 0, 0.02, def.suppressed ? -0.48 : -0.4);
      barrelEnd = def.suppressed ? -0.62 : -0.46;
      break;
    case 'ar':
      box(0.07, 0.12, 0.5, body, 0, 0, -0.2);
      box(0.05, 0.18, 0.07, body, 0, -0.14, -0.15);
      box(0.05, 0.11, 0.22, furniture, 0, -0.01, 0.15);
      box(0.04, 0.05, 0.12, body, 0, 0.09, -0.12); // optic
      cyl(0.018, 0.25, body, 0, 0.02, -0.55);
      barrelEnd = -0.68;
      break;
    case 'battle':
    case 'dmr':
      box(0.08, 0.13, 0.6, body, 0, 0, -0.22);
      box(0.06, 0.14, 0.08, body, 0, -0.12, -0.12);
      box(0.06, 0.12, 0.26, furniture, 0, -0.01, 0.2);
      cyl(0.03, 0.2, body, 0, 0.1, -0.12); // scope tube
      cyl(0.02, 0.3, body, 0, 0.02, -0.66);
      barrelEnd = -0.82;
      break;
    case 'marksman':
      box(0.07, 0.1, 0.75, furniture, 0, 0, -0.25);
      box(0.06, 0.1, 0.3, furniture, 0, -0.02, 0.24);
      cyl(0.035, 0.34, body, 0, 0.11, -0.15); // big scope
      cyl(0.017, 0.5, body, 0, 0.02, -0.8);
      box(0.03, 0.03, 0.06, body, 0.05, 0.04, -0.05); // bolt
      barrelEnd = -1.05;
      break;
    case 'shotgun':
      if (def.id === 'scattercan') {
        box(0.08, 0.13, 0.55, body, 0, 0, -0.2);
        cyl(0.09, 0.08, body, 0, -0.12, -0.12).rotation.set(0, 0, Math.PI / 2); // drum
        box(0.05, 0.11, 0.2, furniture, 0, -0.01, 0.16);
      } else {
        box(0.07, 0.11, 0.6, body, 0, 0, -0.22);
        box(0.06, 0.07, 0.2, furniture, 0, -0.07, -0.35); // pump
        box(0.05, 0.11, 0.24, furniture, 0, -0.01, 0.18);
      }
      cyl(0.03, 0.25, body, 0, 0.02, -0.6);
      barrelEnd = -0.72;
      break;
    case 'lmg':
      box(0.1, 0.15, 0.7, body, 0, 0, -0.25);
      box(0.12, 0.14, 0.14, body, 0, -0.12, -0.1); // box mag
      box(0.06, 0.12, 0.24, furniture, 0, -0.01, 0.2);
      cyl(0.028, 0.35, body, 0, 0.02, -0.75);
      box(0.02, 0.18, 0.02, body, 0.05, -0.12, -0.55); // bipod leg
      box(0.02, 0.18, 0.02, body, -0.05, -0.12, -0.55);
      barrelEnd = -0.93;
      break;
    case 'energy':
      box(0.09, 0.14, 0.55, body, 0, 0, -0.2);
      for (let i = 0; i < 3; i++) box(0.1, 0.03, 0.04, glow, 0, 0.02, -0.25 - i * 0.1);
      box(0.06, 0.12, 0.2, furniture, 0, -0.01, 0.16);
      if (def.id === 'voltlance') {
        cyl(0.03, 0.4, body, 0, 0.02, -0.65);
        box(0.04, 0.04, 0.3, glow, 0, 0.09, -0.35);
        barrelEnd = -0.87;
      } else {
        cyl(0.025, 0.15, glow, 0, 0.02, -0.52);
        barrelEnd = -0.6;
      }
      break;
    case 'revolver':
      box(0.05, 0.1, 0.22, body, 0, 0, -0.08);
      cyl(0.045, 0.07, body, 0, 0, -0.02).rotation.set(0, 0, 0); // cylinder
      cyl(0.018, 0.18, body, 0, 0.03, -0.26);
      box(0.04, 0.12, 0.05, furniture, 0, -0.1, 0.05);
      barrelEnd = -0.36;
      break;
    case 'pistol':
      box(0.045, 0.09, 0.2, body, 0, 0, -0.08);
      box(0.04, 0.11, 0.05, furniture, 0, -0.09, 0.0);
      barrelEnd = -0.18;
      break;
  }
  // Rarity stripe
  box(0.075, 0.015, 0.12, accent, 0, 0.065, -0.05);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, barrelEnd);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  g.userData.cls = def.cls;
  return g;
}
