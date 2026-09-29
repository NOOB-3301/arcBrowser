import * as THREE from 'three';
import type { MapDef } from './MapDef';
import { HEIGHT_FN, RenderGlobals, heightUniforms } from '../render/RenderGlobals';

const vert = /* glsl */ `
  uniform float uTime;
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    wp.y += sin(wp.x * 0.15 + uTime * 1.1) * 0.05 + cos(wp.z * 0.12 + uTime * 0.9) * 0.05;
    vWorld = wp.xyz;
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const frag = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uAmbient;
  uniform float uFlow;
  uniform samplerCube tSky;
  varying vec3 vWorld;
  ${HEIGHT_FN}
  #include <fog_pars_fragment>

  float h21( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
  float vnoise( vec2 p ) {
    vec2 i = floor( p ); vec2 f = fract( p ); vec2 u = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( h21( i ), h21( i + vec2( 1, 0 ) ), u.x ), mix( h21( i + vec2( 0, 1 ) ), h21( i + vec2( 1, 1 ) ), u.x ), u.y );
  }

  void main() {
    vec2 p = vWorld.xz + vec2( 0.0, uTime * uFlow );
    // Analytic ripple normal from a few summed waves + fine noise chop
    vec2 g = vec2( 0.0 );
    g += vec2( 0.8, 0.6 ) * cos( dot( p, vec2( 0.8, 0.6 ) ) * 0.9 + uTime * 1.3 ) * 0.9;
    g += vec2( -0.5, 0.85 ) * cos( dot( p, vec2( -0.5, 0.85 ) ) * 1.7 + uTime * 1.9 ) * 0.45;
    g += vec2( 0.3, -0.95 ) * cos( dot( p, vec2( 0.3, -0.95 ) ) * 3.1 + uTime * 2.6 ) * 0.22;
    g += vec2( -0.9, -0.2 ) * cos( dot( p, vec2( -0.9, -0.2 ) ) * 5.3 + uTime * 3.3 ) * 0.1;
    vec2 q = p * 2.2 + uTime * vec2( 0.3, 0.2 );
    float e = 0.15;
    float n0 = vnoise( q );
    g += vec2( vnoise( q + vec2( e, 0.0 ) ) - n0, vnoise( q + vec2( 0.0, e ) ) - n0 ) / e * 0.08;
    vec3 v = normalize( cameraPosition - vWorld );
    float dist = length( cameraPosition - vWorld );
    // flatten ripples with distance so the far lake doesn't alias
    float chop = mix( 0.09, 0.025, smoothstep( 20.0, 400.0, dist ) );
    vec3 n = normalize( vec3( -g.x * chop, 1.0, -g.y * chop ) );

    float depth = max( vWorld.y - rfTerrainHeight( vWorld.xz ), 0.0 );
    if ( uRfHeight.w < 0.5 ) depth = 4.0;
    float depthK = 1.0 - exp( -depth * 0.35 );

    float ndv = max( dot( n, v ), 0.0 );
    float fres = 0.02 + 0.98 * pow( 1.0 - ndv, 5.0 );
    vec3 r = reflect( -v, n );
    r.y = abs( r.y );
    vec3 refl = textureCube( tSky, r ).rgb;

    float light = dot( uAmbient, vec3( 0.2126, 0.7152, 0.0722 ) ) + max( uSunDir.y, 0.0 ) * dot( uSunColor, vec3( 0.2126, 0.7152, 0.0722 ) ) * 0.25;
    vec3 body = mix( uShallow, uDeep, depthK ) * light;
    vec3 col = mix( body, refl, fres );

    // sun glint (HDR so bloom picks it up)
    vec3 h = normalize( uSunDir + v );
    float spec = pow( max( dot( n, h ), 0.0 ), 600.0 ) * 40.0 + pow( max( dot( n, h ), 0.0 ), 80.0 ) * 0.6;
    col += uSunColor * spec * step( 0.0, uSunDir.y );

    // shoreline foam where the terrain approaches the surface
    float fn = vnoise( vWorld.xz * 1.3 + uTime * vec2( 0.25, -0.2 ) ) * 0.6 + vnoise( vWorld.xz * 3.7 - uTime * 0.4 ) * 0.4;
    float band = 1.0 - smoothstep( 0.0, 0.9, depth );
    float wave = 0.5 + 0.5 * sin( depth * 9.0 - uTime * 2.2 + fn * 3.0 );
    float foam = smoothstep( 0.35, 0.75, fn * band + band * 0.35 * wave ) * band;
    col = mix( col, vec3( 0.9 ) * light * 1.1, foam * 0.85 );

    float alpha = mix( mix( 0.25, 0.93, depthK ), 1.0, fres );
    alpha = max( alpha, foam );
    gl_FragColor = vec4( col, alpha );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

function waterMaterial(flow: number): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
        uSunColor: { value: new THREE.Color('#fff1dc') },
        uDeep: { value: new THREE.Color('#0b2226') },
        uShallow: { value: new THREE.Color('#3d6a5c') },
        uAmbient: { value: new THREE.Color(0.5, 0.55, 0.6) },
        uFlow: { value: flow },
      },
    ]),
  });
  // Shared by reference (textures must not go through UniformsUtils.merge)
  m.uniforms.tSky = RenderGlobals.skyCube as THREE.IUniform;
  Object.assign(m.uniforms, heightUniforms());
  return m;
}

/** Reservoir planes + river ribbons. */
export class Water {
  readonly materials: THREE.ShaderMaterial[] = [];

  constructor(scene: THREE.Scene, def: MapDef) {
    const lakeMat = waterMaterial(0);
    this.materials.push(lakeMat);
    for (const lake of def.lakes) {
      const [cx, cz] = lake.center;
      const [rx, rz] = lake.radius;
      let z0 = cz - rz * 1.35;
      let z1 = cz + rz * 1.35;
      // Stop at the dam face so the reservoir doesn't spill into the valley
      if (def.dam && def.dam.z > z0 && def.dam.z < z1 + 50) z1 = Math.min(z1, def.dam.z - 6);
      const w = rx * 2.7;
      const geo = new THREE.PlaneGeometry(w, z1 - z0, 32, 16);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, lakeMat);
      mesh.position.set(cx, def.waterLevel, (z0 + z1) / 2);
      mesh.renderOrder = 1;
      scene.add(mesh);
    }

    // W4: open sea east of the coastline, out to the horizon
    if (def.coast) {
      const seaMat = waterMaterial(0);
      seaMat.uniforms.uDeep.value.set('#15313d');
      seaMat.uniforms.uShallow.value.set('#2f6670');
      this.materials.push(seaMat);
      const x0 = def.coast.shore - def.coast.wobble - 80;
      const x1 = def.size / 2 + 3000;
      const zl = def.size + 6000;
      const geo = new THREE.PlaneGeometry(x1 - x0, zl, 64, 64);
      geo.rotateX(-Math.PI / 2);
      const sea = new THREE.Mesh(geo, seaMat);
      sea.position.set((x0 + x1) / 2, def.waterLevel, 0);
      sea.renderOrder = 1;
      scene.add(sea);
    }

    const riverMat = waterMaterial(-1.4);
    this.materials.push(riverMat);
    for (const river of def.rivers) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < river.points.length - 1; i++) {
        const a = river.points[i];
        const b = river.points[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const k = Math.max(1, Math.ceil(len / 6));
        for (let j = 0; j < k; j++) {
          const t = j / k;
          pts.push(new THREE.Vector3(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t + 1.3, a[1] + (b[1] - a[1]) * t));
        }
      }
      const last = river.points[river.points.length - 1];
      pts.push(new THREE.Vector3(last[0], last[2] + 1.3, last[1]));
      const half = river.width / 2 + 4;
      const pos: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[Math.min(i + 1, pts.length - 1)];
        const r = pts[Math.max(i - 1, 0)];
        const dir = q.clone().sub(r).setY(0).normalize();
        const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(half);
        pos.push(p.x + side.x, p.y, p.z + side.z, p.x - side.x, p.y, p.z - side.z);
        if (i > 0) {
          const a = (i - 1) * 2;
          idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, riverMat);
      mesh.material.side = THREE.DoubleSide;
      mesh.renderOrder = 1;
      scene.add(mesh);
    }
  }

  /** Sun + ambient come from RenderGlobals (set by DayNight); params kept for API compatibility. */
  update(dt: number, _sunDir?: THREE.Vector3, _sunColor?: THREE.Color, _sky?: THREE.Color): void {
    for (const m of this.materials) {
      m.uniforms.uTime.value += dt;
      m.uniforms.uSunDir.value.copy(RenderGlobals.sunDir);
      m.uniforms.uSunColor.value.copy(RenderGlobals.sunColor);
      m.uniforms.uAmbient.value.copy(RenderGlobals.ambientUp);
    }
  }
}
