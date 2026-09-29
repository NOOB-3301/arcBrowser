import * as THREE from 'three';
import type { Heightmap } from './Heightmap';
import type { ExtractDef } from './MapDef';

const beamVert = /* glsl */ `
  varying float vY;
  void main() {
    vY = uv.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const beamFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying float vY;
  void main() {
    float a = (1.0 - vY) * (0.35 + 0.15 * sin(uTime * 2.0 - vY * 20.0));
    gl_FragColor = vec4(uColor * a, a);
  }
`;

export interface ExtractPoint {
  def: ExtractDef;
  pos: THREE.Vector3;
}

/** Visual markers for extraction points: ground ring, light beam, label. */
export class Extracts {
  readonly points: ExtractPoint[] = [];
  private beamMat: THREE.ShaderMaterial;
  private rings: THREE.Mesh[] = [];

  constructor(scene: THREE.Scene, hm: Heightmap, defs: ExtractDef[]) {
    this.beamMat = new THREE.ShaderMaterial({
      vertexShader: beamVert,
      fragmentShader: beamFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uColor: { value: new THREE.Color('#5cffb0') }, uTime: { value: 0 } },
    });
    const ringMat = new THREE.MeshBasicMaterial({ color: '#5cffb0', transparent: true, opacity: 0.7, depthWrite: false });
    for (const def of defs) {
      const pos = def.pos.length === 3 ? new THREE.Vector3(def.pos[0], def.pos[1], def.pos[2]) : new THREE.Vector3(def.pos[0], hm.sample(def.pos[0], def.pos[1]), def.pos[1]);
      this.points.push({ def, pos });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.8, 140, 16, 1, true), this.beamMat);
      beam.position.copy(pos).add(new THREE.Vector3(0, 70, 0));
      scene.add(beam);
      const ring = new THREE.Mesh(new THREE.RingGeometry(4.6, 5, 48), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.copy(pos).add(new THREE.Vector3(0, 0.15, 0));
      scene.add(ring);
      this.rings.push(ring);
      const label = makeLabel(`⇪ ${def.name}`);
      label.position.copy(pos).add(new THREE.Vector3(0, 4, 0));
      scene.add(label);
    }
  }

  update(dt: number): void {
    this.beamMat.uniforms.uTime.value += dt;
    const s = 1 + Math.sin(this.beamMat.uniforms.uTime.value * 2) * 0.04;
    for (const r of this.rings) r.scale.setScalar(s);
  }
}

function makeLabel(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(10,30,20,0.7)';
  g.fillRect(0, 0, 512, 64);
  g.fillStyle = '#7dffc0';
  g.font = 'bold 30px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 33);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, sizeAttenuation: true }));
  s.scale.set(6, 0.75, 1);
  return s;
}
