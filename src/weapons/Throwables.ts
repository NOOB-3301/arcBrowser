import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Input } from '../core/Input';
import { Events } from '../core/Events';
import type { Physics } from '../physics/Physics';
import { hostile, type Damageable, type DamageRegistry } from '../combat/Damage';
import type { Effects } from '../combat/Effects';
import { explode } from '../combat/Explosions';
import type { CameraRig } from '../camera/CameraRig';
import type { PlayerController } from '../player/PlayerController';
import { SenseMods } from '../ai/SenseMods';
import { Sfx } from '../audio/Sfx';

/**
 * W4 — throwables. Manual ballistic arc with raycast collision + bounce.
 *
 * Controls (the `throwable` action, G / LB):
 *   - tap  (< 0.22 s): cycle the selected type (skips empty ones)
 *   - hold: show the trajectory arc + landing marker; release to throw.
 *
 * Counts are a simple counter for now: `add(id, n)`, and `Events.emit('throwable:use', { id })`
 * throws that type immediately (for the W3 inventory). Emits `throwable:changed` on any change
 * and `throwable:thrown` { id } after a throw.
 */

export type ThrowableId = 'frag' | 'emp' | 'smoke' | 'decoy' | 'mine';

export const THROWABLE_DEFS: Record<ThrowableId, { name: string; color: string; fuse: number; short: string }> = {
  frag: { name: 'Frag Grenade', color: '#6d7a4a', fuse: 3, short: 'FRG' },
  emp: { name: 'EMP Charge', color: '#4fb8ff', fuse: 1.4, short: 'EMP' },
  smoke: { name: 'Smoke Grenade', color: '#b8b8b0', fuse: 1.2, short: 'SMK' },
  decoy: { name: 'Noise Decoy', color: '#ffb020', fuse: 0.8, short: 'DCY' },
  mine: { name: 'Proximity Mine', color: '#e03a2a', fuse: 1, short: 'MIN' },
};
const ORDER: ThrowableId[] = ['frag', 'emp', 'smoke', 'decoy', 'mine'];

const GRAVITY = 13;
const THROW_SPEED = 19;
const RADIUS = 0.09;
const TAP_TIME = 0.22;
const FRAG = { radius: 6, damage: 110 };
const EMP = { radius: 7, stun: 4 };
const SMOKE = { radius: 6.5, life: 12 };
const DECOY = { life: 8, interval: 0.7, noise: 70 };
const MINE = { trigger: 3.5, radius: 5.5, damage: 130 };

interface Projectile {
  id: ThrowableId;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  t: number;
  resting: boolean;
  stuck: boolean;
  armed: boolean;
  triggerT: number;
  active: boolean;
  activeT: number;
  pingT: number;
  mesh: THREE.Mesh;
  light?: THREE.Mesh;
}

interface Cloud {
  pos: THREE.Vector3;
  age: number;
  radius: number;
  puffs: { off: THREE.Vector3; vel: THREE.Vector3; size: number }[];
}

const _pts: THREE.Vector3[] = [];
const _v = new THREE.Vector3();

export class Throwables {
  readonly counts: Record<ThrowableId, number> = { frag: 3, emp: 1, smoke: 1, decoy: 1, mine: 1 };
  selected: ThrowableId = 'frag';
  private items: Projectile[] = [];
  private clouds: Cloud[] = [];
  private holdT = -1;
  private aiming = false;
  private preview: THREE.Line;
  private marker: THREE.Mesh;
  private smokePts: THREE.Points;
  private smokeGeo = new THREE.BufferGeometry();
  private smokePos = new Float32Array(600 * 3);
  private smokeSize = new Float32Array(600);
  private smokeAlpha = new Float32Array(600);
  private geo = new THREE.SphereGeometry(RADIUS * 1.4, 10, 8);

  constructor(
    private scene: THREE.Scene,
    private physics: Physics,
    private registry: DamageRegistry,
    private effects: Effects,
    private rig: CameraRig,
    private player: PlayerController,
    private owner: Damageable,
  ) {
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(90 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.preview = new THREE.Line(pg, new THREE.LineDashedMaterial({ color: '#ffe0a0', dashSize: 0.35, gapSize: 0.2, transparent: true, opacity: 0.85, depthTest: false }));
    this.preview.frustumCulled = false;
    this.preview.visible = false;
    this.preview.renderOrder = 5;
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.7, 32),
      new THREE.MeshBasicMaterial({ color: '#ffe0a0', transparent: true, opacity: 0.8, depthTest: false, side: THREE.DoubleSide }),
    );
    this.marker.visible = false;
    this.marker.renderOrder = 5;
    scene.add(this.preview, this.marker);

    this.smokeGeo.setAttribute('position', new THREE.BufferAttribute(this.smokePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.smokeGeo.setAttribute('aSize', new THREE.BufferAttribute(this.smokeSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.smokeGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.smokeAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.smokePts = new THREE.Points(this.smokeGeo, smokeMaterial());
    this.smokePts.frustumCulled = false;
    this.smokePts.renderOrder = 4;
    scene.add(this.smokePts);

    SenseMods.smokeBlocks = (a, b) => this.smokeBlocks(a, b);
    Events.on('throwable:use', ({ id }: { id: ThrowableId }) => {
      if (this.countOf(id) > 0) this.throwNow(id);
    });
  }

  /**
   * Where counts come from. Null = internal debug counters (arena). In a raid the
   * inventory plugs in here so grenades are real items (integration W3×W4).
   */
  source: { count(id: ThrowableId): number; consume(id: ThrowableId): void } | null = null;

  countOf(id: ThrowableId): number {
    return this.source ? this.source.count(id) : this.counts[id];
  }

  add(id: ThrowableId, n: number): void {
    this.counts[id] = Math.max(0, this.counts[id] + n);
    Events.emit('throwable:changed', { id, count: this.counts[id], selected: this.selected });
  }

  get count(): number {
    return this.countOf(this.selected);
  }

  /** Throwable id → live projectile count (debug/tests). */
  get live(): number {
    return this.items.length;
  }

  cycle(): void {
    const i = ORDER.indexOf(this.selected);
    for (let k = 1; k <= ORDER.length; k++) {
      const id = ORDER[(i + k) % ORDER.length];
      if (this.countOf(id) > 0 || k === ORDER.length) {
        this.selected = id;
        break;
      }
    }
    Events.emit('throwable:changed', { id: this.selected, count: this.count, selected: this.selected });
  }

  // ---------------------------------------------------------------- input (per frame)

  update(dt: number, input: Input, active: boolean): void {
    if (active && input.pressed('throwable')) this.holdT = 0;
    if (this.holdT >= 0) {
      if (input.down('throwable') && active) {
        this.holdT += dt;
        if (this.holdT > TAP_TIME && this.count > 0) this.aiming = true;
      } else {
        if (this.aiming) this.throwNow(this.selected);
        else if (active && this.holdT <= TAP_TIME) this.cycle();
        this.holdT = -1;
        this.aiming = false;
      }
    }
    if (this.aiming) this.updatePreview();
    this.preview.visible = this.marker.visible = this.aiming;
    this.renderItems(dt);
  }

  private launch(out: { pos: THREE.Vector3; vel: THREE.Vector3 }): void {
    const yaw = this.rig.yaw;
    const pitch = Math.min(1.2, this.rig.pitch + 0.2);
    const fwd = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    out.pos.copy(this.player.renderCenter).add(new THREE.Vector3(0, 0.75, 0)).addScaledVector(right, 0.3).addScaledVector(fwd, 0.3);
    out.vel.copy(fwd).multiplyScalar(THROW_SPEED).add(new THREE.Vector3(this.player.velocity.x, 0, this.player.velocity.z).multiplyScalar(0.5));
  }

  private updatePreview(): void {
    const s = { pos: new THREE.Vector3(), vel: new THREE.Vector3() };
    this.launch(s);
    const attr = this.preview.geometry.attributes.position as THREE.BufferAttribute;
    const h = 1 / 30;
    let n = 0;
    let landed: { point: THREE.Vector3; normal: THREE.Vector3 } | null = null;
    for (let i = 0; i < 90; i++) {
      attr.setXYZ(n++, s.pos.x, s.pos.y, s.pos.z);
      s.vel.y -= GRAVITY * h;
      const step = s.vel.length() * h;
      const dir = _v.copy(s.vel).normalize();
      const hit = this.physics.raycast(s.pos, dir, step + RADIUS, this.player.collider);
      if (hit) {
        landed = { point: hit.point, normal: hit.normal };
        attr.setXYZ(n++, hit.point.x, hit.point.y, hit.point.z);
        break;
      }
      s.pos.addScaledVector(s.vel, h);
    }
    attr.needsUpdate = true;
    this.preview.geometry.setDrawRange(0, n);
    this.preview.computeLineDistances();
    if (landed) {
      this.marker.visible = true;
      this.marker.position.copy(landed.point).addScaledVector(landed.normal, 0.05);
      this.marker.lookAt(landed.point.clone().add(landed.normal));
      (this.marker.material as THREE.MeshBasicMaterial).color.set(THROWABLE_DEFS[this.selected].color).lerp(new THREE.Color('#fff'), 0.5);
    }
  }

  private throwNow(id: ThrowableId): void {
    if (this.countOf(id) <= 0) return;
    if (this.source) this.source.consume(id);
    else this.counts[id]--;
    const s = { pos: new THREE.Vector3(), vel: new THREE.Vector3() };
    this.launch(s);
    const mesh = new THREE.Mesh(this.geo, new THREE.MeshStandardMaterial({ color: THROWABLE_DEFS[id].color, roughness: 0.5, metalness: 0.4, emissive: THROWABLE_DEFS[id].color, emissiveIntensity: 0.15 }));
    mesh.castShadow = true;
    this.scene.add(mesh);
    const p: Projectile = { id, pos: s.pos, vel: s.vel, t: 0, resting: false, stuck: false, armed: false, triggerT: -1, active: false, activeT: 0, pingT: 0, mesh };
    if (id === 'mine' || id === 'decoy') {
      p.light = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), new THREE.MeshBasicMaterial({ color: id === 'mine' ? '#ff2010' : '#ffc040' }));
      mesh.add(p.light);
      p.light.position.y = RADIUS * 1.3;
    }
    this.items.push(p);
    Sfx.throwItem();
    Events.emit('throwable:thrown', { id });
    Events.emit('throwable:changed', { id, count: this.countOf(id), selected: this.selected });
    if (this.countOf(this.selected) === 0) this.cycle();
  }

  // ---------------------------------------------------------------- simulation (fixed step)

  step(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.t += dt;
      if (!p.resting && !p.stuck) this.integrate(p, dt);
      const def = THROWABLE_DEFS[p.id];
      switch (p.id) {
        case 'frag':
          if (p.t >= def.fuse) {
            explode(this.physics, this.registry, this.effects, p.pos.clone().add(new THREE.Vector3(0, 0.4, 0)), { ...FRAG, faction: this.owner.faction, team: this.owner.team, byPlayer: true, attacker: this.owner, size: 1.2 });
            this.remove(i);
          }
          break;
        case 'emp':
          if (p.t >= def.fuse) {
            this.emp(p.pos);
            this.remove(i);
          }
          break;
        case 'smoke':
          if (p.t >= def.fuse && !p.active) {
            p.active = true;
            this.spawnCloud(p.pos);
          }
          if (p.active && p.t > def.fuse + SMOKE.life) this.remove(i);
          break;
        case 'decoy':
          if ((p.t >= def.fuse || p.resting) && !p.active) p.active = true;
          if (p.active) {
            p.activeT += dt;
            p.pingT -= dt;
            if (p.pingT <= 0) {
              p.pingT = DECOY.interval;
              Events.emit('noise', { pos: p.pos.clone(), radius: DECOY.noise, source: 'decoy' });
              Sfx.decoyPing(p.pos);
            }
            if (p.activeT > DECOY.life) this.remove(i);
          }
          break;
        case 'mine':
          if ((p.stuck || p.resting) && !p.armed && p.t >= def.fuse) {
            p.armed = true;
            Sfx.mineArm(p.pos);
          }
          if (p.armed && p.triggerT < 0 && this.hostileNear(p.pos, MINE.trigger)) {
            p.triggerT = 0;
            Sfx.beep(p.pos, true);
          }
          if (p.triggerT >= 0) {
            p.triggerT += dt;
            if (p.triggerT > 0.25) {
              explode(this.physics, this.registry, this.effects, p.pos.clone(), { radius: MINE.radius, damage: MINE.damage, faction: this.owner.faction, team: this.owner.team, byPlayer: true, attacker: this.owner, size: 1.1 });
              this.remove(i);
            }
          }
          if (p.t > 180) this.remove(i);
          break;
      }
    }
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const c = this.clouds[i];
      c.age += dt;
      c.radius = SMOKE.radius * Math.min(1, 0.35 + c.age / 1.5) * (c.age > SMOKE.life - 2 ? Math.max(0, (SMOKE.life - c.age) / 2) : 1);
      if (c.age > SMOKE.life) this.clouds.splice(i, 1);
    }
  }

  private integrate(p: Projectile, dt: number): void {
    p.vel.y -= GRAVITY * dt;
    const speed = p.vel.length();
    const dist = speed * dt;
    if (dist < 1e-6) return;
    const dir = _v.copy(p.vel).divideScalar(speed);
    const hit = this.physics.raycast(p.pos, dir, dist + RADIUS, p.t < 0.3 ? this.player.collider : undefined);
    if (!hit) {
      p.pos.addScaledVector(p.vel, dt);
      return;
    }
    p.pos.copy(hit.point).addScaledVector(hit.normal, RADIUS);
    if (p.id === 'mine') {
      // Sticks to whatever it hits
      p.stuck = true;
      p.vel.set(0, 0, 0);
      p.mesh.lookAt(p.pos.clone().add(hit.normal));
      p.mesh.rotateX(Math.PI / 2);
      Sfx.bounce(p.pos);
      return;
    }
    // Bounce: reflect, lose energy, add friction along the surface
    const vn = hit.normal.clone().multiplyScalar(p.vel.dot(hit.normal));
    const vt = p.vel.clone().sub(vn);
    p.vel.copy(vt.multiplyScalar(0.7)).addScaledVector(vn, -0.35);
    if (speed > 2) Sfx.bounce(p.pos);
    if (p.vel.length() < 1.2 && hit.normal.y > 0.6) {
      p.resting = true;
      p.vel.set(0, 0, 0);
    }
  }

  private hostileNear(pos: THREE.Vector3, r: number): boolean {
    for (const t of this.registry.targets) {
      if (t === this.owner || !t.health.alive || !hostile(t.faction, this.owner.faction) || t.faction === 'neutral' || t.faction === 'dummy') continue;
      _pts.length = 0;
      t.aimPoints(_pts);
      for (const q of _pts) if (q.distanceTo(pos) < r + 0.8) return true;
    }
    return false;
  }

  private emp(pos: THREE.Vector3): void {
    Sfx.emp(pos);
    Events.emit('noise', { pos: pos.clone(), radius: 50, source: 'explosion' });
    Events.emit('explosion', { pos: pos.clone(), radius: 1.5, size: 0.3 });
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const e = pos.clone().add(new THREE.Vector3(Math.cos(a) * EMP.radius, (Math.random() - 0.2) * 2, Math.sin(a) * EMP.radius));
      this.effects.lightning(pos, e, 0x7fd0ff);
    }
    this.effects.impact(pos, new THREE.Vector3(0, 1, 0), 'machine', false);
    for (const t of this.registry.targets) {
      if (t === this.owner || !t.health.alive || !hostile(t.faction, this.owner.faction)) continue;
      _pts.length = 0;
      t.aimPoints(_pts);
      const near = _pts.some((q) => q.distanceTo(pos) < EMP.radius);
      if (!near) continue;
      t.health.shield = 0;
      const s = (t as unknown as { stun?: (s: number) => void }).stun;
      if (s) s.call(t, EMP.stun);
      if (_pts[0]) this.effects.lightning(pos, _pts[0], 0xaee4ff);
    }
  }

  private spawnCloud(pos: THREE.Vector3): void {
    Sfx.smokePop(pos);
    const puffs: Cloud['puffs'] = [];
    for (let i = 0; i < 90; i++) {
      const off = new THREE.Vector3((Math.random() - 0.5) * 2, Math.random() * 0.6, (Math.random() - 0.5) * 2).multiplyScalar(0.5);
      const vel = new THREE.Vector3((Math.random() - 0.5), Math.random() * 0.5 + 0.05, (Math.random() - 0.5)).normalize().multiplyScalar(0.8 + Math.random() * 0.8);
      puffs.push({ off, vel, size: 3.5 + Math.random() * 3.5 });
    }
    this.clouds.push({ pos: pos.clone(), age: 0, radius: 1, puffs });
  }

  /** Does any smoke cloud block the segment a→b? */
  smokeBlocks(a: THREE.Vector3, b: THREE.Vector3): boolean {
    for (const c of this.clouds) {
      if (c.age < 0.4) continue;
      const center = _v.copy(c.pos).add(new THREE.Vector3(0, c.radius * 0.35, 0));
      const ab = b.clone().sub(a);
      const len = ab.length();
      const t = THREE.MathUtils.clamp(center.clone().sub(a).dot(ab) / (len * len || 1), 0, 1);
      const closest = a.clone().addScaledVector(ab, t);
      if (closest.distanceTo(center) < c.radius * 0.9) return true;
    }
    return false;
  }

  /** Test hook: number of active smoke clouds. */
  get smokeCount(): number {
    return this.clouds.length;
  }

  private remove(i: number): void {
    const p = this.items[i];
    this.scene.remove(p.mesh);
    (p.mesh.material as THREE.Material).dispose();
    this.items.splice(i, 1);
  }

  // ---------------------------------------------------------------- visuals (per frame)

  private renderItems(dt: number): void {
    for (const p of this.items) {
      p.mesh.position.copy(p.pos);
      if (!p.resting && !p.stuck) p.mesh.rotation.x += dt * 12;
      if (p.light) {
        const rate = p.id === 'mine' ? (p.triggerT >= 0 ? 30 : p.armed ? 3 : 0) : p.active ? 6 : 0;
        p.light.visible = rate === 0 ? false : Math.sin(p.t * rate * Math.PI) > 0;
      }
    }
    // Smoke puffs
    let n = 0;
    for (const c of this.clouds) {
      const fade = Math.min(1, c.age * 2) * Math.min(1, (SMOKE.life - c.age) / 2.5);
      for (const q of c.puffs) {
        if (n >= 600) break;
        // Puffs expand outward to fill the cloud radius, then drift
        const k = Math.min(1, c.age / 2);
        const px = c.pos.x + q.off.x + q.vel.x * c.radius * 0.75 * k;
        const py = c.pos.y + 0.8 + q.off.y + Math.abs(q.vel.y) * c.radius * 0.6 * k + c.age * 0.05;
        const pz = c.pos.z + q.off.z + q.vel.z * c.radius * 0.75 * k;
        this.smokePos.set([px, py, pz], n * 3);
        this.smokeSize[n] = q.size * (0.6 + 0.4 * k) * (c.radius / SMOKE.radius + 0.3);
        this.smokeAlpha[n] = 0.7 * fade;
        n++;
      }
    }
    this.smokeGeo.setDrawRange(0, n);
    this.smokeGeo.attributes.position.needsUpdate = true;
    this.smokeGeo.attributes.aSize.needsUpdate = true;
    this.smokeGeo.attributes.aAlpha.needsUpdate = true;
  }

  /** Physics collider of the thrower (preview/throw exclusion). */
  get excludeCollider(): RAPIER.Collider {
    return this.player.collider;
  }
}

function smokeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color('#b9b8b2') } }]),
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aAlpha;
      varying float vAlpha;
      #include <fog_pars_vertex>
      void main() {
        vAlpha = aAlpha;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * 420.0 / max(1.0, -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAlpha;
      #include <fog_pars_fragment>
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        float a = smoothstep(0.5, 0.1, d) * vAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor * (0.85 + 0.3 * (0.5 - c.y)), a);
        #include <fog_fragment>
      }`,
  });
}
