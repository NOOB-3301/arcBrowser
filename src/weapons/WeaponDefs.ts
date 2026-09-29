/**
 * Original weapon roster. All tuning lives here; Weapon.ts is behaviour only.
 * Angles in degrees, speeds m/s, times seconds, recoil in radians per shot.
 */

export type AmmoType = 'light' | 'medium' | 'heavy' | 'shells' | 'cells';
export type WeaponClass = 'smg' | 'ar' | 'battle' | 'marksman' | 'dmr' | 'shotgun' | 'lmg' | 'energy' | 'pistol' | 'revolver';
export type FireMode = 'auto' | 'burst' | 'semi' | 'charge';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export interface Falloff {
  start: number;
  end: number;
  min: number;
}

export interface RecoilDef {
  /** Upward kick per shot (rad). */
  vertical: number;
  /** Consistent sideways drift per shot (rad, + = right). */
  horizontalBias: number;
  /** Random sideways kick amplitude (rad). */
  horizontalRandom: number;
  /** Fraction of accumulated kick auto-recovered after firing stops. */
  recovery: number;
  /** Visual camera shake per shot (trauma units). */
  shake: number;
}

export interface WeaponDef {
  id: string;
  name: string;
  cls: WeaponClass;
  ammo: AmmoType;
  damage: number;
  rpm: number;
  magSize: number;
  modes: FireMode[];
  burstCount?: number;
  /** Pause between bursts. */
  burstDelay?: number;
  reloadTactical: number;
  reloadEmpty: number;
  /** Shotguns reload shell by shell. */
  reloadPerShell?: number;
  pellets?: number;
  hipSpread: number;
  adsSpread: number;
  /** Spread added per shot, decays at bloomRecovery deg/s. */
  bloom: number;
  bloomMax: number;
  bloomRecovery: number;
  moveSpreadMult: number;
  muzzleVelocity: number;
  /** Bullet gravity multiplier (0 = energy bolts fly straight). */
  gravity: number;
  falloff: Falloff;
  headMultiplier: number;
  penetration: number;
  /** ADS magnification (1.3 irons … 4 scope). */
  adsZoom: number;
  adsTime: number;
  swapTime: number;
  /** kg, slows movement + ADS a bit. */
  weight: number;
  recoil: RecoilDef;
  /** Hearing radius of a shot (m). */
  noise: number;
  tracerColor: number;
  // Specials
  /** Bolt/pump cycle after each shot (overrides rpm between shots). */
  cycleTime?: number;
  /** Time to reach full fire rate while holding trigger. */
  spinUp?: number;
  spinUpStartRpm?: number;
  chargeTime?: number;
  /** Heat per shot; 100 = overheat. Replaces magazine. */
  heatPerShot?: number;
  heatDecay?: number;
  overheatLockout?: number;
  /** Energy cells drawn from reserve per shot (heat weapons). */
  cellsPerShot?: number;
  /** Chain lightning to nearby targets. */
  chain?: { range: number; targets: number; damageMult: number };
  /** Alternate ammo (slug) toggled with the fire-mode button. */
  altAmmo?: { name: string; damage: number; pellets: number; spreadMult: number; muzzleVelocity: number; falloff: Falloff };
  /** Scope glint visible to AI when aiming. */
  glint?: boolean;
  suppressed?: boolean;
  /** Suppression pressure applied to bots near misses (M5). */
  suppression?: number;
  description: string;
}

const R = (deg: number) => (deg * Math.PI) / 180;

export const WEAPONS: Record<string, WeaponDef> = {
  hornet9: {
    id: 'hornet9', name: 'Hornet-9', cls: 'smg', ammo: 'light',
    damage: 14, rpm: 900, magSize: 30, modes: ['auto'],
    reloadTactical: 1.8, reloadEmpty: 2.3,
    hipSpread: 2.6, adsSpread: 0.9, bloom: 0.35, bloomMax: 3.5, bloomRecovery: 9, moveSpreadMult: 1.2,
    muzzleVelocity: 380, gravity: 1, falloff: { start: 15, end: 40, min: 0.5 },
    headMultiplier: 1.5, penetration: 0.1, adsZoom: 1.3, adsTime: 0.18, swapTime: 0.4, weight: 2.6,
    recoil: { vertical: R(0.45), horizontalBias: R(0.08), horizontalRandom: R(0.35), recovery: 0.6, shake: 0.03 },
    noise: 70, tracerColor: 0xffd28a,
    description: 'Buzzing close-quarters SMG. Bloom climbs fast—tap or commit.',
  },
  tern: {
    id: 'tern', name: 'Tern PDW', cls: 'smg', ammo: 'light',
    damage: 17, rpm: 1100, magSize: 24, modes: ['burst'], burstCount: 3, burstDelay: 0.22,
    reloadTactical: 1.9, reloadEmpty: 2.4,
    hipSpread: 2.4, adsSpread: 0.7, bloom: 0.2, bloomMax: 2.5, bloomRecovery: 8, moveSpreadMult: 1.1,
    muzzleVelocity: 400, gravity: 1, falloff: { start: 18, end: 45, min: 0.5 },
    headMultiplier: 1.6, penetration: 0.15, adsZoom: 1.35, adsTime: 0.2, swapTime: 0.4, weight: 2.4,
    recoil: { vertical: R(0.55), horizontalBias: R(-0.05), horizontalRandom: R(0.2), recovery: 0.7, shake: 0.03 },
    noise: 22, suppressed: true, tracerColor: 0xbfe6ff,
    description: 'Integrally suppressed burst PDW. Quiet enough to pass most patrols.',
  },
  mako: {
    id: 'mako', name: 'Mako AR', cls: 'ar', ammo: 'medium',
    damage: 22, rpm: 650, magSize: 30, modes: ['auto', 'burst', 'semi'], burstCount: 3, burstDelay: 0.25,
    reloadTactical: 2.1, reloadEmpty: 2.7,
    hipSpread: 3.0, adsSpread: 0.35, bloom: 0.25, bloomMax: 2.8, bloomRecovery: 7, moveSpreadMult: 1.3,
    muzzleVelocity: 720, gravity: 1, falloff: { start: 35, end: 90, min: 0.6 },
    headMultiplier: 1.7, penetration: 0.3, adsZoom: 1.5, adsTime: 0.25, swapTime: 0.5, weight: 3.4,
    recoil: { vertical: R(0.55), horizontalBias: R(0.12), horizontalRandom: R(0.28), recovery: 0.55, shake: 0.04 },
    noise: 90, tracerColor: 0xffc070,
    description: 'Dependable all-rounder with auto, burst and semi.',
  },
  brigand: {
    id: 'brigand', name: 'Brigand', cls: 'battle', ammo: 'heavy',
    damage: 42, rpm: 330, magSize: 20, modes: ['semi'],
    reloadTactical: 2.4, reloadEmpty: 3.0,
    hipSpread: 3.4, adsSpread: 0.25, bloom: 0.7, bloomMax: 3, bloomRecovery: 6, moveSpreadMult: 1.4,
    muzzleVelocity: 780, gravity: 1, falloff: { start: 50, end: 120, min: 0.65 },
    headMultiplier: 1.8, penetration: 0.5, adsZoom: 1.6, adsTime: 0.3, swapTime: 0.55, weight: 4.3,
    recoil: { vertical: R(1.4), horizontalBias: R(0.2), horizontalRandom: R(0.5), recovery: 0.75, shake: 0.09 },
    noise: 110, tracerColor: 0xffb060,
    description: 'Heavy-round battle rifle. Hits like a truck, kicks like one.',
  },
  longwatch: {
    id: 'longwatch', name: 'Longwatch', cls: 'marksman', ammo: 'heavy',
    damage: 115, rpm: 60, magSize: 5, modes: ['semi'], cycleTime: 1.1,
    reloadTactical: 3.2, reloadEmpty: 3.8,
    hipSpread: 6, adsSpread: 0.02, bloom: 0, bloomMax: 0, bloomRecovery: 10, moveSpreadMult: 2.5,
    muzzleVelocity: 900, gravity: 1, falloff: { start: 100, end: 350, min: 0.8 },
    headMultiplier: 2.5, penetration: 0.7, adsZoom: 4, adsTime: 0.38, swapTime: 0.6, weight: 5.5,
    recoil: { vertical: R(3.2), horizontalBias: R(0.3), horizontalRandom: R(0.6), recovery: 0.85, shake: 0.14 },
    noise: 150, glint: true, tracerColor: 0xffe0a0,
    description: 'Bolt-action long rifle. Real bullet drop. Scope glint gives you away.',
  },
  ferrous: {
    id: 'ferrous', name: 'Ferrous DMR', cls: 'dmr', ammo: 'medium',
    damage: 48, rpm: 240, magSize: 12, modes: ['semi'],
    reloadTactical: 2.3, reloadEmpty: 2.9,
    hipSpread: 4, adsSpread: 0.12, bloom: 0.5, bloomMax: 2.5, bloomRecovery: 7, moveSpreadMult: 1.6,
    muzzleVelocity: 850, gravity: 1, falloff: { start: 70, end: 180, min: 0.7 },
    headMultiplier: 1.9, penetration: 0.9, adsZoom: 2.2, adsTime: 0.3, swapTime: 0.55, weight: 4.4,
    recoil: { vertical: R(1.6), horizontalBias: R(-0.15), horizontalRandom: R(0.4), recovery: 0.8, shake: 0.07 },
    noise: 110, tracerColor: 0xd0f0ff,
    description: 'Tungsten-core marksman rifle. Punches straight through ARC plating.',
  },
  rookhammer: {
    id: 'rookhammer', name: 'Rookhammer', cls: 'shotgun', ammo: 'shells',
    damage: 13, pellets: 9, rpm: 70, magSize: 6, modes: ['semi'], cycleTime: 0.75,
    reloadTactical: 0, reloadEmpty: 0, reloadPerShell: 0.5,
    hipSpread: 5.5, adsSpread: 4, bloom: 0, bloomMax: 0, bloomRecovery: 10, moveSpreadMult: 1.1,
    muzzleVelocity: 380, gravity: 1, falloff: { start: 8, end: 25, min: 0.2 },
    headMultiplier: 1.3, penetration: 0.1, adsZoom: 1.2, adsTime: 0.22, swapTime: 0.5, weight: 3.6,
    recoil: { vertical: R(3.5), horizontalBias: R(0), horizontalRandom: R(1), recovery: 0.9, shake: 0.16 },
    noise: 100, tracerColor: 0xffc080,
    altAmmo: { name: 'Slug', damage: 75, pellets: 1, spreadMult: 0.12, muzzleVelocity: 520, falloff: { start: 25, end: 70, min: 0.5 } },
    description: 'Pump shotgun. Fire-mode button swaps buckshot ↔ slug.',
  },
  scattercan: {
    id: 'scattercan', name: 'Scattercan', cls: 'shotgun', ammo: 'shells',
    damage: 9, pellets: 8, rpm: 240, magSize: 20, modes: ['auto'],
    reloadTactical: 3.2, reloadEmpty: 3.9,
    hipSpread: 6.5, adsSpread: 4.8, bloom: 0.3, bloomMax: 2, bloomRecovery: 6, moveSpreadMult: 1.1,
    muzzleVelocity: 360, gravity: 1, falloff: { start: 6, end: 20, min: 0.2 },
    headMultiplier: 1.25, penetration: 0.05, adsZoom: 1.2, adsTime: 0.26, swapTime: 0.6, weight: 5.2,
    recoil: { vertical: R(1.8), horizontalBias: R(0.2), horizontalRandom: R(0.9), recovery: 0.7, shake: 0.1 },
    noise: 100, tracerColor: 0xffc080,
    description: 'Drum-fed automatic shotgun. Room clearer, useless past 20 m.',
  },
  grindstone: {
    id: 'grindstone', name: 'Grindstone', cls: 'lmg', ammo: 'medium',
    damage: 20, rpm: 760, magSize: 100, modes: ['auto'], spinUp: 0.6, spinUpStartRpm: 300,
    reloadTactical: 4.5, reloadEmpty: 5.5,
    hipSpread: 4, adsSpread: 1.0, bloom: 0.08, bloomMax: 2, bloomRecovery: 4, moveSpreadMult: 1.6,
    muzzleVelocity: 740, gravity: 1, falloff: { start: 40, end: 100, min: 0.6 },
    headMultiplier: 1.5, penetration: 0.35, adsZoom: 1.4, adsTime: 0.45, swapTime: 0.8, weight: 8.5,
    recoil: { vertical: R(0.35), horizontalBias: R(0.1), horizontalRandom: R(0.45), recovery: 0.4, shake: 0.035 },
    noise: 120, suppression: 1, tracerColor: 0xff9a50,
    description: 'Spin-up LMG. Slow to start, impossible to push through. Suppresses.',
  },
  voltlance: {
    id: 'voltlance', name: 'Volt Lance', cls: 'energy', ammo: 'cells',
    damage: 95, rpm: 70, magSize: 0, modes: ['charge'], chargeTime: 0.8,
    heatPerShot: 34, heatDecay: 28, overheatLockout: 2.2, cellsPerShot: 5,
    reloadTactical: 0, reloadEmpty: 0,
    hipSpread: 2, adsSpread: 0.05, bloom: 0, bloomMax: 0, bloomRecovery: 10, moveSpreadMult: 1.5,
    muzzleVelocity: 1500, gravity: 0, falloff: { start: 80, end: 200, min: 0.75 },
    headMultiplier: 2.0, penetration: 0.6, adsZoom: 2.0, adsTime: 0.3, swapTime: 0.6, weight: 4.8,
    recoil: { vertical: R(2.2), horizontalBias: R(0), horizontalRandom: R(0.3), recovery: 0.85, shake: 0.12 },
    noise: 80, tracerColor: 0x66e0ff,
    description: 'Charge rifle: hold to charge, release to fire. Overheats instead of reloading.',
  },
  arcsplitter: {
    id: 'arcsplitter', name: 'Arcsplitter', cls: 'energy', ammo: 'cells',
    damage: 12, rpm: 750, magSize: 0, modes: ['auto'],
    heatPerShot: 3.4, heatDecay: 32, overheatLockout: 2.0, cellsPerShot: 1,
    chain: { range: 7, targets: 2, damageMult: 0.45 },
    reloadTactical: 0, reloadEmpty: 0,
    hipSpread: 2.8, adsSpread: 1.1, bloom: 0.15, bloomMax: 2, bloomRecovery: 8, moveSpreadMult: 1.2,
    muzzleVelocity: 950, gravity: 0, falloff: { start: 15, end: 40, min: 0.5 },
    headMultiplier: 1.4, penetration: 0.25, adsZoom: 1.3, adsTime: 0.2, swapTime: 0.45, weight: 3.0,
    recoil: { vertical: R(0.25), horizontalBias: R(0), horizontalRandom: R(0.3), recovery: 0.7, shake: 0.02 },
    noise: 60, tracerColor: 0x8ab4ff,
    description: 'Energy SMG. Hits arc to nearby targets—brutal against ARC swarms.',
  },
  wrenchback: {
    id: 'wrenchback', name: 'Wrenchback', cls: 'revolver', ammo: 'heavy',
    damage: 58, rpm: 150, magSize: 6, modes: ['semi'],
    reloadTactical: 2.8, reloadEmpty: 2.8,
    hipSpread: 2.4, adsSpread: 0.35, bloom: 1.2, bloomMax: 3, bloomRecovery: 5, moveSpreadMult: 1.3,
    muzzleVelocity: 480, gravity: 1, falloff: { start: 25, end: 60, min: 0.5 },
    headMultiplier: 2.0, penetration: 0.4, adsZoom: 1.35, adsTime: 0.2, swapTime: 0.3, weight: 1.6,
    recoil: { vertical: R(2.6), horizontalBias: R(0.3), horizontalRandom: R(0.5), recovery: 0.85, shake: 0.08 },
    noise: 100, tracerColor: 0xffd090,
    description: 'Six-shot revolver. Two to the head ends most arguments.',
  },
  pip: {
    id: 'pip', name: 'Pip', cls: 'pistol', ammo: 'light',
    damage: 18, rpm: 420, magSize: 15, modes: ['semi'],
    reloadTactical: 1.4, reloadEmpty: 1.8,
    hipSpread: 1.8, adsSpread: 0.5, bloom: 0.4, bloomMax: 2.5, bloomRecovery: 8, moveSpreadMult: 1.1,
    muzzleVelocity: 360, gravity: 1, falloff: { start: 15, end: 40, min: 0.5 },
    headMultiplier: 1.8, penetration: 0.1, adsZoom: 1.25, adsTime: 0.15, swapTime: 0.25, weight: 1.0,
    recoil: { vertical: R(0.9), horizontalBias: R(0.05), horizontalRandom: R(0.35), recovery: 0.85, shake: 0.03 },
    noise: 60, tracerColor: 0xffd8a0,
    description: 'Compact backup pistol. Fast out of the holster.',
  },
};

export const RARITY: Record<Rarity, { damage: number; recoil: number; mag: number; reload: number; color: string }> = {
  common: { damage: 1.0, recoil: 1.0, mag: 1.0, reload: 1.0, color: '#b9b4a8' },
  uncommon: { damage: 1.05, recoil: 0.95, mag: 1.0, reload: 0.95, color: '#6fcf5a' },
  rare: { damage: 1.1, recoil: 0.9, mag: 1.1, reload: 0.9, color: '#4aa3ff' },
  epic: { damage: 1.15, recoil: 0.85, mag: 1.2, reload: 0.85, color: '#b36bff' },
  legendary: { damage: 1.2, recoil: 0.8, mag: 1.3, reload: 0.8, color: '#ffae2a' },
};

export const AMMO_LABEL: Record<AmmoType, string> = {
  light: 'Light', medium: 'Medium', heavy: 'Heavy', shells: 'Shells', cells: 'Cells',
};
