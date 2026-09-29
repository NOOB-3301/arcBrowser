export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  label: string;
  /** Multiplier on devicePixelRatio, then clamped to maxPixelRatio. */
  pixelRatio: number;
  maxPixelRatio: number;
  /** Screen-space AO (N8AO). */
  ao: boolean;
  aoQuality: 'Performance' | 'Low' | 'Medium' | 'High';
  aoHalfRes: boolean;
  bloom: boolean;
  /** Bloom internal resolution scale. */
  bloomScale: number;
  godRays: boolean;
  godRaySamples: number;
  smaa: boolean;
  /** Film-look pass: vignette + chromatic aberration + grain. */
  filmFx: boolean;
  /** Sun shadow cascades (1–4) and per-cascade map size. */
  shadowCascades: number;
  shadowMapSize: number;
  /** Cascade far edges in metres (length = shadowCascades). */
  shadowSplits: number[];
  shadowRadius: number;
  /** GPU grass. */
  grassRadius: number;
  grassSpacing: number;
  /** Terrain LOD distance multiplier and camera far plane (draw distance). */
  lodScale: number;
  drawDistance: number;
  /** Texture detail: 0 = full, 1 = half res (drops top mip), 2 = quarter. */
  textureDrop: number;
  normalMaps: boolean;
  anisotropy: number;
  /** Env map resolution for image-based lighting. */
  envSize: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: {
    label: 'Low', pixelRatio: 0.75, maxPixelRatio: 1, ao: false, aoQuality: 'Performance', aoHalfRes: true,
    bloom: false, bloomScale: 0.25, godRays: false, godRaySamples: 0, smaa: false, filmFx: false,
    shadowCascades: 2, shadowMapSize: 1024, shadowSplits: [25, 110], shadowRadius: 1.5,
    grassRadius: 18, grassSpacing: 0.6, lodScale: 0.6, drawDistance: 1500,
    textureDrop: 1, normalMaps: false, anisotropy: 2, envSize: 64,
  },
  medium: {
    label: 'Medium', pixelRatio: 1, maxPixelRatio: 1, ao: true, aoQuality: 'Performance', aoHalfRes: true,
    bloom: true, bloomScale: 0.25, godRays: false, godRaySamples: 0, smaa: true, filmFx: true,
    shadowCascades: 2, shadowMapSize: 2048, shadowSplits: [30, 170], shadowRadius: 2,
    grassRadius: 26, grassSpacing: 0.5, lodScale: 0.8, drawDistance: 2000,
    textureDrop: 1, normalMaps: true, anisotropy: 4, envSize: 128,
  },
  high: {
    label: 'High', pixelRatio: 1, maxPixelRatio: 1.5, ao: true, aoQuality: 'Low', aoHalfRes: true,
    bloom: true, bloomScale: 0.5, godRays: true, godRaySamples: 28, smaa: true, filmFx: true,
    shadowCascades: 3, shadowMapSize: 2048, shadowSplits: [22, 80, 260], shadowRadius: 2.5,
    grassRadius: 34, grassSpacing: 0.42, lodScale: 1, drawDistance: 2600,
    textureDrop: 0, normalMaps: true, anisotropy: 8, envSize: 256,
  },
  ultra: {
    label: 'Ultra', pixelRatio: 1, maxPixelRatio: 2, ao: true, aoQuality: 'Medium', aoHalfRes: false,
    bloom: true, bloomScale: 0.5, godRays: true, godRaySamples: 48, smaa: true, filmFx: true,
    shadowCascades: 4, shadowMapSize: 2048, shadowSplits: [16, 50, 130, 300], shadowRadius: 3,
    grassRadius: 44, grassSpacing: 0.36, lodScale: 1.4, drawDistance: 2600,
    textureDrop: 0, normalMaps: true, anisotropy: 16, envSize: 256,
  },
};

type Listener = (q: QualityPreset, level: QualityLevel) => void;
const listeners = new Set<Listener>();

function initialLevel(): QualityLevel {
  try {
    const raw = localStorage.getItem('rustfall.settings.v1');
    const v = raw ? (JSON.parse(raw).graphicsQuality as QualityLevel | undefined) : undefined;
    if (v && v in QUALITY_PRESETS) return v;
  } catch {
    // storage blocked; fall through to default
  }
  return 'high';
}

/** Current graphics quality. Subsystems read `Quality.current` at build time and subscribe for live changes. */
export const Quality = {
  level: initialLevel(),
  get current(): QualityPreset {
    return QUALITY_PRESETS[this.level];
  },
  /** Subscribe to changes; returns an unsubscribe function. Does not fire immediately. */
  onChange(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function setQuality(level: QualityLevel): void {
  if (!(level in QUALITY_PRESETS)) return;
  Quality.level = level;
  const q = QUALITY_PRESETS[level];
  for (const fn of listeners) fn(q, level);
}
