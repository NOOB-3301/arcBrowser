import * as THREE from 'three';
import type { Surface } from './Damage';

const MAX_TRACERS = 512;
const MAX_PARTICLES = 1500;
const MAX_DECALS = 160;

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  color: THREE.Color;
  size: number;
  gravity: number;
}

interface Bolt {
  points: THREE.Vector3[];
  life: number;
  color: THREE.Color;
}

const SURFACE_FX: Record<Surface, { color: string; count: number; speed: number; sparks: boolean }> = {
  dirt: { color: '#6b5a42', count: 10, speed: 2.5, sparks: false },
  concrete: { color: '#a59e90', count: 9, speed: 3, sparks: false },
  metal: { color: '#ffcc66', count: 12, speed: 6, sparks: true },
  flesh: { color: '#9a2a22', count: 10, speed: 2.5, sparks: false },
  machine: { color: '#7fd4ff', count: 14, speed: 6, sparks: true },
};

/**
 * Pooled combat FX: tracers, muzzle flashes, impact particles, bullet decals,
 * lightning arcs. One draw call per effect type.
 */
export class Effects {
  // Tracers: written each frame from live projectiles
  private tracerGeo = new THREE.BufferGeometry();
  private tracerPos = new Float32Array(MAX_TRACERS * 6);
  private tracerCol = new Float32Array(MAX_TRACERS * 6);
  private tracerCount = 0;
  private tracers: THREE.LineSegments;

  // Particles
  private particles: Particle[] = [];
  private pGeo = new THREE.BufferGeometry();
  private pPos = new Float32Array(MAX_PARTICLES * 3);
  private pCol = new Float32Array(MAX_PARTICLES * 3);
  private points: THREE.Points;

  // Muzzle flash
  private flash: THREE.Sprite;
  private flashLight = new THREE.PointLight('#ffb060', 0, 8, 2);
  private flashT = 0;

  // Decals
  private decals: THREE.InstancedMesh;
  private decalIndex = 0;
  private dummy = new THREE.Object3D();

  // Lightning
  private bolts: Bolt[] = [];
  private boltGeo = new THREE.BufferGeometry();
  private boltPos = new Float32Array(400 * 6);
  private boltCol = new Float32Array(400 * 6);
  private boltLines: THREE.LineSegments;

  constructor(private scene: THREE.Scene) {
    this.tracerGeo.setAttribute('position', new THREE.BufferAttribute(this.tracerPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.tracerGeo.setAttribute('color', new THREE.BufferAttribute(this.tracerCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.tracers = new THREE.LineSegments(
      this.tracerGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.tracers.frustumCulled = false;
    scene.add(this.tracers);

    this.pGeo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.pGeo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(
      this.pGeo,
      new THREE.PointsMaterial({ size: 0.07, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true }),
    );
    this.points.frustumCulled = false;
    scene.add(this.points);

    this.flash = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: radialTexture(), color: '#ffc27a', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
    );
    this.flash.visible = false;
    scene.add(this.flash, this.flashLight);

    this.decals = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.045, 8),
      new THREE.MeshBasicMaterial({ color: '#1a1714', transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }),
      MAX_DECALS,
    );
    this.decals.count = 0;
    this.decals.frustumCulled = false;
    scene.add(this.decals);

    this.boltGeo.setAttribute('position', new THREE.BufferAttribute(this.boltPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.boltGeo.setAttribute('color', new THREE.BufferAttribute(this.boltCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.boltLines = new THREE.LineSegments(
      this.boltGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
    );
    this.boltLines.frustumCulled = false;
    scene.add(this.boltLines);
  }

  // ---------------------------------------------------------------- API

  /** Called by Ballistics each frame before render. */
  beginTracers(): void {
    this.tracerCount = 0;
  }

  addTracer(head: THREE.Vector3, tail: THREE.Vector3, color: THREE.Color, brightness: number): void {
    if (this.tracerCount >= MAX_TRACERS) return;
    const i = this.tracerCount++ * 6;
    this.tracerPos.set([head.x, head.y, head.z, tail.x, tail.y, tail.z], i);
    this.tracerCol.set([color.r * brightness, color.g * brightness, color.b * brightness, 0, 0, 0], i);
  }

  muzzleFlash(pos: THREE.Vector3, color: number, size = 1): void {
    this.flash.position.copy(pos);
    this.flash.material.color.setHex(color);
    this.flash.scale.setScalar(0.35 * size * (0.8 + Math.random() * 0.4));
    this.flash.material.rotation = Math.random() * Math.PI;
    this.flash.visible = true;
    this.flashLight.position.copy(pos);
    this.flashLight.color.setHex(color);
    this.flashLight.intensity = 6 * size;
    this.flashT = 0.05;
  }

  impact(point: THREE.Vector3, normal: THREE.Vector3, surface: Surface, decal: boolean): void {
    const fx = SURFACE_FX[surface];
    const col = new THREE.Color(fx.color);
    for (let i = 0; i < fx.count; i++) {
      const dir = normal.clone().add(randomUnit().multiplyScalar(0.8)).normalize();
      this.spawnParticle(point, dir.multiplyScalar(fx.speed * (0.4 + Math.random())), col, fx.sparks ? 0.25 : 0.45, fx.sparks ? 0.5 : 1);
    }
    if (fx.sparks) {
      for (let i = 0; i < 4; i++) {
        const dir = normal.clone().add(randomUnit()).normalize();
        this.spawnParticle(point, dir.multiplyScalar(9), new THREE.Color('#fff2c0'), 0.15, 0.3);
      }
    }
    if (decal) this.addDecal(point, normal);
  }

  /** Jagged arc between two points (chain lightning). */
  lightning(a: THREE.Vector3, b: THREE.Vector3, color = 0x9cc4ff): void {
    const pts: THREE.Vector3[] = [];
    const segs = 8;
    const len = a.distanceTo(b);
    for (let i = 0; i <= segs; i++) {
      const p = a.clone().lerp(b, i / segs);
      if (i > 0 && i < segs) p.add(randomUnit().multiplyScalar(len * 0.06));
      pts.push(p);
    }
    this.bolts.push({ points: pts, life: 0.12, color: new THREE.Color(color) });
  }

  update(dt: number): void {
    // Tracers
    this.tracerGeo.setDrawRange(0, this.tracerCount * 2);
    (this.tracerGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.tracerGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    // Flash
    this.flashT -= dt;
    if (this.flashT <= 0 && this.flash.visible) {
      this.flash.visible = false;
      this.flashLight.intensity = 0;
    }

    // Particles
    let n = 0;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.vel.y -= 9.81 * p.gravity * dt;
      p.vel.multiplyScalar(1 - 1.5 * dt);
      p.pos.addScaledVector(p.vel, dt);
      const k = p.life / p.maxLife;
      this.pPos.set([p.pos.x, p.pos.y, p.pos.z], n * 3);
      this.pCol.set([p.color.r * k, p.color.g * k, p.color.b * k], n * 3);
      n++;
    }
    this.pGeo.setDrawRange(0, n);
    (this.pGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.pGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    // Bolts
    let bn = 0;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life -= dt;
      if (b.life <= 0) {
        this.bolts.splice(i, 1);
        continue;
      }
      for (let j = 0; j < b.points.length - 1 && bn < 400; j++, bn++) {
        const p = b.points[j];
        const q = b.points[j + 1];
        this.boltPos.set([p.x, p.y, p.z, q.x, q.y, q.z], bn * 6);
        this.boltCol.set([b.color.r, b.color.g, b.color.b, b.color.r, b.color.g, b.color.b], bn * 6);
      }
    }
    this.boltGeo.setDrawRange(0, bn * 2);
    (this.boltGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.boltGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  // ---------------------------------------------------------------- internals

  private spawnParticle(pos: THREE.Vector3, vel: THREE.Vector3, color: THREE.Color, life: number, gravity: number): void {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    const l = life * (0.6 + Math.random() * 0.8);
    this.particles.push({ pos: pos.clone(), vel, life: l, maxLife: l, color, size: 1, gravity });
  }

  private addDecal(point: THREE.Vector3, normal: THREE.Vector3): void {
    this.dummy.position.copy(point).addScaledVector(normal, 0.01);
    this.dummy.lookAt(point.clone().add(normal));
    this.dummy.rotateZ(Math.random() * Math.PI);
    this.dummy.scale.setScalar(0.7 + Math.random() * 0.6);
    this.dummy.updateMatrix();
    this.decals.setMatrixAt(this.decalIndex, this.dummy.matrix);
    this.decalIndex = (this.decalIndex + 1) % MAX_DECALS;
    this.decals.count = Math.min(this.decals.count + 1, MAX_DECALS);
    this.decals.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.tracers, this.points, this.flash, this.flashLight, this.decals, this.boltLines);
  }
}

function randomUnit(): THREE.Vector3 {
  const u = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return new THREE.Vector3(s * Math.cos(t), u, s * Math.sin(t));
}

let _radial: THREE.Texture | null = null;
function radialTexture(): THREE.Texture {
  if (_radial) return _radial;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,220,150,0.8)');
  grad.addColorStop(1, 'rgba(255,120,40,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  _radial = new THREE.CanvasTexture(c);
  return _radial;
}
