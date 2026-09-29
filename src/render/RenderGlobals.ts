import * as THREE from 'three';

/**
 * Renderer-wide shared state. Uniform objects here are shared by reference with
 * every material that uses them, so writing `.value` (or the fields of the
 * plain-object vec4s) updates all shaders at once.
 *
 * Other systems drive:
 *  - `wetness.value` 0..1 (weather): darkens porous albedo, lowers roughness, adds puddles.
 */
export const RenderGlobals = {
  /** 0 = dry, 1 = soaked. Terrain + kit shaders read it. */
  wetness: { value: 0 },
  /** Seconds, advanced by PostFX each frame. */
  time: { value: 0 },
  /** Terrain height field (R32F, texel = heightmap cell) for grime / shoreline effects. */
  heightTex: { value: null as THREE.Texture | null },
  /** (half size, cell size, samples per side, has heightmap 0/1) */
  heightParams: { value: new THREE.Vector4(1, 1, 1, 0) },
  /** Sky radiance captured for reflections (water). */
  skyCube: { value: null as THREE.Texture | null },
  /** Sun direction (towards the sun) and colour * intensity (linear), set by DayNight. */
  sunDir: new THREE.Vector3(0.4, 0.8, 0.3).normalize(),
  sunColor: new THREE.Color(3, 2.9, 2.7),
  /** Ambient irradiance approximations from the sky capture (linear). */
  ambientUp: new THREE.Color(0.35, 0.4, 0.45),
  ambientDown: new THREE.Color(0.12, 0.1, 0.08),
};

/*
 * Atmosphere uniforms. Plain {x,y,z,w} objects are *not* cloned by three's
 * UniformsUtils.clone, so every material compiled with fog shares them.
 */
export const FogUniforms = {
  /** xyz = direction to sun, w = sun in-scatter strength */
  sun: { x: 0.4, y: 0.6, z: 0.3, w: 0.6 },
  /** rgb = in-scatter colour (linear), w = height falloff (1/m) */
  sunColor: { x: 1, y: 0.8, z: 0.6, w: 0.012 },
  /** x = fog base height (m), y = density multiplier, z = sky-dome haze blend, w = min fog near camera */
  params: { x: 20, y: 1, z: 0, w: 0 },
};

const FOG_PARS_VERT = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorld;
#endif
`;

const FOG_VERT = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // view -> world without needing modelMatrix (works for instancing, sprites, custom shaders)
  vFogWorld = ( mvPosition.xyz - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix );
#endif
`;

const FOG_PARS_FRAG = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorld;
  uniform vec4 rfFogSun;
  uniform vec4 rfFogSunColor;
  uniform vec4 rfFogParams;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif

  // Exponential height fog with sun in-scattering (aerial perspective).
  vec3 rfApplyFog( vec3 col, vec3 worldPos ) {
    vec3 ray = worldPos - cameraPosition;
    float dist = length( ray );
    vec3 dir = ray / max( dist, 1e-4 );
    #ifdef FOG_EXP2
      float start = 0.0;
      float density = fogDensity;
    #else
      float start = fogNear;
      // fogFar = distance at which ground-level fog reaches ~95%
      float density = 3.0 / max( fogFar - fogNear, 1.0 );
    #endif
    density *= rfFogParams.y;
    float falloff = max( rfFogSunColor.w, 1e-5 );
    float travelled = max( dist - start, 0.0 );
    // integrate density * exp(-falloff * (h - base)) along the ray
    float h0 = cameraPosition.y + dir.y * min( start, dist ) - rfFogParams.x;
    float dy = dir.y * travelled * falloff;
    float integral = abs( dy ) > 1e-3 ? ( 1.0 - exp( - dy ) ) / dy : 1.0 - 0.5 * dy;
    float amount = density * exp( - falloff * max( h0, -40.0 ) ) * travelled * integral;
    float fogF = 1.0 - exp( - amount );
    fogF = max( fogF, rfFogParams.w * smoothstep( 0.0, 60.0, dist ) );
    float sunAmt = pow( max( dot( dir, rfFogSun.xyz ), 0.0 ), 6.0 );
    vec3 fcol = mix( fogColor, rfFogSunColor.rgb, clamp( sunAmt * rfFogSun.w, 0.0, 1.0 ) );
    return mix( col, fcol, clamp( fogF, 0.0, 1.0 ) );
  }
#endif
`;

const FOG_FRAG = /* glsl */ `
#ifdef USE_FOG
  gl_FragColor.rgb = rfApplyFog( gl_FragColor.rgb, vFogWorld );
#endif
`;

let installed = false;

/** Patch three's global shader chunks + uniform libraries. Must run before any shader compiles. */
export function installRenderGlobals(): void {
  if (installed) return;
  installed = true;
  THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERT;
  THREE.ShaderChunk.fog_vertex = FOG_VERT;
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAG;
  THREE.ShaderChunk.fog_fragment = FOG_FRAG;

  const extra = {
    rfFogSun: { value: FogUniforms.sun },
    rfFogSunColor: { value: FogUniforms.sunColor },
    rfFogParams: { value: FogUniforms.params },
  };
  Object.assign(THREE.UniformsLib.fog, extra);
  for (const lib of Object.values(THREE.ShaderLib) as { uniforms: Record<string, THREE.IUniform> }[]) {
    if (lib.uniforms && 'fogColor' in lib.uniforms) Object.assign(lib.uniforms, extra);
  }
}

installRenderGlobals();

/** GLSL: bilinear terrain height from RenderGlobals.heightTex (uniforms tRfHeight, uRfHeight). */
export const HEIGHT_FN = /* glsl */ `
  uniform highp sampler2D tRfHeight;
  uniform vec4 uRfHeight;
  float rfTerrainHeight( vec2 w ) {
    if ( uRfHeight.w < 0.5 ) return 0.0;
    vec2 f = ( w + uRfHeight.x ) / uRfHeight.y;
    vec2 i = floor( f );
    vec2 t = f - i;
    ivec2 c = ivec2( clamp( i, vec2( 0.0 ), vec2( uRfHeight.z - 2.0 ) ) );
    float h00 = texelFetch( tRfHeight, c, 0 ).r;
    float h10 = texelFetch( tRfHeight, c + ivec2( 1, 0 ), 0 ).r;
    float h01 = texelFetch( tRfHeight, c + ivec2( 0, 1 ), 0 ).r;
    float h11 = texelFetch( tRfHeight, c + ivec2( 1, 1 ), 0 ).r;
    return mix( mix( h00, h10, t.x ), mix( h01, h11, t.x ), t.y );
  }
`;

const dummyHeight = new THREE.DataTexture(new Float32Array(4), 2, 2, THREE.RedFormat, THREE.FloatType);
dummyHeight.needsUpdate = true;
RenderGlobals.heightTex.value = dummyHeight;

/** Register the terrain height field (called by the map's foliage/terrain setup). */
export function setTerrainHeight(tex: THREE.Texture, half: number, cell: number, n: number): void {
  RenderGlobals.heightTex.value = tex;
  RenderGlobals.heightParams.value.set(half, cell, n, 1);
}

/** Uniform entries for HEIGHT_FN, shared by reference. */
export function heightUniforms(): Record<string, THREE.IUniform> {
  return { tRfHeight: RenderGlobals.heightTex, uRfHeight: RenderGlobals.heightParams };
}
