import * as THREE from 'three';
import type { Physics } from '../physics/Physics';

/**
 * Greybox movement/combat test arena: ledges of known heights, slopes, stairs,
 * cover, dynamic crates and distance markers. Used until real maps land (M4).
 */
export class TestArena {
  readonly spawn = new THREE.Vector3(0, 2, 8);

  constructor(private scene: THREE.Scene, private physics: Physics) {}

  build(): void {
    this.ground();
    this.ledges();
    this.ramps();
    this.stairs();
    this.cover();
    this.crates();
    this.markers();
    this.tower();
  }

  // ------------------------------------------------------------------ helpers

  private grid(color: string, line: string, size = 512, cells = 8): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    g.fillStyle = color;
    g.fillRect(0, 0, size, size);
    g.strokeStyle = line;
    const step = size / cells;
    for (let i = 0; i <= cells; i++) {
      g.lineWidth = i % 4 === 0 ? 4 : 1.5;
      g.beginPath();
      g.moveTo(i * step, 0);
      g.lineTo(i * step, size);
      g.moveTo(0, i * step);
      g.lineTo(size, i * step);
      g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  private mat(color: string, line: string, repeat: number): THREE.MeshStandardMaterial {
    const map = this.grid(color, line);
    map.repeat.set(repeat, repeat);
    return new THREE.MeshStandardMaterial({ map, roughness: 0.9, metalness: 0.05 });
  }

  private box(
    pos: THREE.Vector3,
    size: THREE.Vector3,
    material: THREE.Material,
    rot?: THREE.Euler,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
    mesh.position.copy(pos);
    if (rot) mesh.rotation.copy(rot);
    mesh.castShadow = mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.physics.addStaticBox(pos, size.clone().multiplyScalar(0.5), mesh.quaternion);
    return mesh;
  }

  // ------------------------------------------------------------------ pieces

  private ground(): void {
    const size = 400;
    const mat = this.mat('#5b6250', '#474d3e', size / 4);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.physics.addStaticBox(new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(size / 2, 0.5, size / 2));
  }

  /** Ledges at 0.5 / 1 / 1.5 / 2 / 2.5 m for mantle tuning. */
  private ledges(): void {
    const mat = this.mat('#b8793c', '#8d5a28', 1);
    [0.5, 1, 1.5, 2, 2.5].forEach((h, i) => {
      this.box(new THREE.Vector3(-20 + i * 5, h / 2, -10), new THREE.Vector3(3, h, 3), mat);
    });
  }

  /** Ramps at 15 / 30 / 45 / 60 degrees. */
  private ramps(): void {
    const mat = this.mat('#6d7a86', '#4f5a63', 1);
    [15, 30, 45, 60].forEach((deg, i) => {
      const a = THREE.MathUtils.degToRad(deg);
      const len = 10;
      const x = 12 + i * 6;
      const h = Math.sin(a) * len;
      this.box(
        new THREE.Vector3(x, h / 2 - 0.1, -12),
        new THREE.Vector3(4, 0.4, len),
        mat,
        new THREE.Euler(a, 0, 0),
      );
    });
  }

  private stairs(): void {
    const mat = this.mat('#8a8a8a', '#666', 1);
    const rise = 0.2;
    const run = 0.35;
    for (let i = 0; i < 16; i++) {
      const h = rise * (i + 1);
      this.box(new THREE.Vector3(-30, h / 2, 10 - i * run), new THREE.Vector3(3, h, run), mat);
    }
    this.box(new THREE.Vector3(-30, 1.6, 2.5), new THREE.Vector3(3, 3.2, 4), mat);
  }

  private cover(): void {
    const mat = this.mat('#7c7466', '#5c5549', 1);
    // Low cover (crouch), high cover (stand), pillars for peeking
    for (let i = 0; i < 6; i++) {
      this.box(new THREE.Vector3(-12 + i * 5, 0.5, 20), new THREE.Vector3(3, 1, 0.6), mat);
      this.box(new THREE.Vector3(-12 + i * 5, 1.25, 30), new THREE.Vector3(2, 2.5, 0.6), mat);
    }
    for (let i = 0; i < 4; i++) {
      this.box(new THREE.Vector3(20 + i * 6, 3, 25), new THREE.Vector3(1.2, 6, 1.2), mat);
    }
    // Corridor for camera collision tests
    this.box(new THREE.Vector3(40, 2, 0), new THREE.Vector3(0.5, 4, 20), mat);
    this.box(new THREE.Vector3(43, 2, 0), new THREE.Vector3(0.5, 4, 20), mat);
    this.box(new THREE.Vector3(41.5, 4.25, 0), new THREE.Vector3(3.5, 0.5, 20), mat);
  }

  private crates(): void {
    const mat = this.mat('#9c8a4a', '#6f6232', 1);
    const half = new THREE.Vector3(0.5, 0.5, 0.5);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4 - y; x++) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
        mesh.position.set(8 + x * 1.05 + y * 0.52, 0.5 + y * 1.01, 10);
        mesh.castShadow = mesh.receiveShadow = true;
        this.scene.add(mesh);
        this.physics.addDynamicBox(mesh, half, 0.5);
      }
    }
  }

  /** Posts every 25 m along +Z/-Z for judging scale and weapon range. */
  private markers(): void {
    const mat = new THREE.MeshStandardMaterial({ color: '#d84a2a', roughness: 0.6 });
    for (let d = 25; d <= 200; d += 25) {
      for (const sign of [-1, 1]) {
        this.box(new THREE.Vector3(60, 1.5, sign * d), new THREE.Vector3(0.4, 3, 0.4), mat);
      }
    }
  }

  private tower(): void {
    const mat = this.mat('#55606a', '#3c444b', 2);
    this.box(new THREE.Vector3(-45, 6, -30), new THREE.Vector3(8, 12, 8), mat);
  }
}
