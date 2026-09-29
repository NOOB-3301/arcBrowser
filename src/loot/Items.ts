import { Events } from '../core/Events';
import { WEAPONS, RARITY, type AmmoType, type Rarity, type WeaponClass } from '../weapons/WeaponDefs';

/**
 * Item database. Every loot / stash / inventory entry references an ItemDef by id.
 * Weapons are generated from WEAPONS (id `wpn_<weaponId>`); their rarity lives on
 * the stack instance, everything else has a fixed rarity.
 */

export type ItemCategory = 'weapon' | 'ammo' | 'med' | 'shield' | 'throwable' | 'key' | 'valuable' | 'material';

export type IconId =
  | 'pistol' | 'smg' | 'rifle' | 'shotgun' | 'sniper' | 'lmg' | 'energy'
  | 'ammo' | 'shells' | 'cells' | 'bandage' | 'medkit' | 'shieldcell' | 'shield'
  | 'frag' | 'emp' | 'smoke' | 'decoy' | 'mine' | 'key' | 'keycard'
  | 'scrap' | 'fabric' | 'chip' | 'battery' | 'alloy' | 'chem' | 'core' | 'optic' | 'servo'
  | 'watch' | 'drive' | 'camera' | 'idol' | 'relay';

export interface MedEffect {
  hp: number;
  shield: number;
  /** Seconds the effect is applied over. */
  time: number;
}

export interface ItemDef {
  id: string;
  name: string;
  cat: ItemCategory;
  w: number;
  h: number;
  /** kg per unit. */
  weight: number;
  /** Credits per unit (at the item's base rarity). */
  value: number;
  stack: number;
  rarity: Rarity;
  icon: IconId;
  desc: string;
  weaponId?: string;
  ammo?: AmmoType;
  med?: MedEffect;
  /** Shield capacity for equippable shields. */
  shieldCap?: number;
  /** Extract / container id this key opens. */
  opens?: string;
}

/** One item instance (a stack) wherever it lives. */
export interface ItemStack {
  uid: number;
  id: string;
  qty: number;
  /** Weapons roll their rarity per instance. */
  rarity?: Rarity;
  /** Rounds loaded in a weapon's magazine. */
  mag?: number;
  /** Remaining charge of an equipped shield. */
  charge?: number;
  /** Grid position (set by the owning grid). */
  x: number;
  y: number;
}

let nextUid = 1;
export function newUid(): number {
  return nextUid++;
}
/** Keep uids unique after loading saved stacks. */
export function bumpUid(seen: number): void {
  if (seen >= nextUid) nextUid = seen + 1;
}

export const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
const RARITY_VALUE: Record<Rarity, number> = { common: 1, uncommon: 1.6, rare: 2.6, epic: 4.2, legendary: 7 };

const WEAPON_SHAPE: Record<WeaponClass, { w: number; h: number; icon: IconId; value: number }> = {
  pistol: { w: 2, h: 1, icon: 'pistol', value: 260 },
  revolver: { w: 2, h: 1, icon: 'pistol', value: 480 },
  smg: { w: 3, h: 2, icon: 'smg', value: 700 },
  ar: { w: 4, h: 2, icon: 'rifle', value: 1100 },
  battle: { w: 4, h: 2, icon: 'rifle', value: 1500 },
  dmr: { w: 4, h: 2, icon: 'sniper', value: 1400 },
  marksman: { w: 5, h: 2, icon: 'sniper', value: 1800 },
  shotgun: { w: 4, h: 2, icon: 'shotgun', value: 950 },
  lmg: { w: 5, h: 2, icon: 'lmg', value: 2100 },
  energy: { w: 4, h: 2, icon: 'energy', value: 2400 },
};

const defs: ItemDef[] = [];

// ---- Weapons (generated from the roster)
for (const w of Object.values(WEAPONS)) {
  const s = WEAPON_SHAPE[w.cls];
  defs.push({
    id: `wpn_${w.id}`, name: w.name, cat: 'weapon', w: s.w, h: s.h, weight: w.weight, value: s.value, stack: 1,
    rarity: 'common', icon: s.icon, desc: w.description, weaponId: w.id, ammo: w.ammo,
  });
}

// ---- Ammo
const ammo: [AmmoType, string, number, number, IconId][] = [
  ['light', 'Light Ammo', 120, 0.6, 'ammo'],
  ['medium', 'Medium Ammo', 90, 1.1, 'ammo'],
  ['heavy', 'Heavy Ammo', 40, 3, 'ammo'],
  ['shells', 'Shotgun Shells', 30, 3.5, 'shells'],
  ['cells', 'Energy Cells', 200, 0.5, 'cells'],
];
for (const [t, name, stack, value, icon] of ammo) {
  defs.push({ id: `ammo_${t}`, name, cat: 'ammo', w: 1, h: 1, weight: 0.012, value, stack, rarity: 'common', icon, desc: `Reserve ammunition (${t}).`, ammo: t });
}

defs.push(
  // ---- Meds
  { id: 'bandage', name: 'Bandage', cat: 'med', w: 1, h: 1, weight: 0.1, value: 90, stack: 5, rarity: 'common', icon: 'bandage', desc: 'Restores 20 HP over 3 s.', med: { hp: 20, shield: 0, time: 3 } },
  { id: 'medkit', name: 'Med Kit', cat: 'med', w: 1, h: 2, weight: 0.6, value: 320, stack: 2, rarity: 'uncommon', icon: 'medkit', desc: 'Restores 50 HP over 5 s.', med: { hp: 50, shield: 0, time: 5 } },
  { id: 'shield_cell', name: 'Shield Cell', cat: 'med', w: 1, h: 1, weight: 0.25, value: 220, stack: 4, rarity: 'uncommon', icon: 'shieldcell', desc: 'Restores 40 shield over 2 s.', med: { hp: 0, shield: 40, time: 2 } },
  // ---- Shields (equipment)
  { id: 'shield_light', name: 'Light Shield', cat: 'shield', w: 2, h: 2, weight: 2, value: 600, stack: 1, rarity: 'common', icon: 'shield', desc: '40 shield capacity.', shieldCap: 40 },
  { id: 'shield_medium', name: 'Medium Shield', cat: 'shield', w: 2, h: 2, weight: 3.5, value: 1400, stack: 1, rarity: 'rare', icon: 'shield', desc: '60 shield capacity.', shieldCap: 60 },
  { id: 'shield_heavy', name: 'Heavy Shield', cat: 'shield', w: 2, h: 2, weight: 5.5, value: 2800, stack: 1, rarity: 'epic', icon: 'shield', desc: '80 shield capacity. Slows you down.', shieldCap: 80 },
  // ---- Throwables (behaviour implemented by W4 via 'throwable:use')
  { id: 'frag', name: 'Frag Grenade', cat: 'throwable', w: 1, h: 1, weight: 0.4, value: 300, stack: 3, rarity: 'uncommon', icon: 'frag', desc: 'Fused fragmentation grenade.' },
  { id: 'emp', name: 'EMP Charge', cat: 'throwable', w: 1, h: 1, weight: 0.5, value: 420, stack: 3, rarity: 'rare', icon: 'emp', desc: 'Stuns ARC machines and strips shields.' },
  { id: 'smoke', name: 'Smoke Canister', cat: 'throwable', w: 1, h: 1, weight: 0.35, value: 160, stack: 3, rarity: 'common', icon: 'smoke', desc: 'Blocks line of sight.' },
  { id: 'decoy', name: 'Noise Decoy', cat: 'throwable', w: 1, h: 1, weight: 0.3, value: 180, stack: 3, rarity: 'common', icon: 'decoy', desc: 'Emits gunfire noise to pull attention.' },
  { id: 'mine', name: 'Proximity Mine', cat: 'throwable', w: 1, h: 1, weight: 0.8, value: 380, stack: 2, rarity: 'rare', icon: 'mine', desc: 'Arms on landing. Triggers on movement.' },
  // ---- Keys
  { id: 'key_hatch', name: 'Radio Hatch Key', cat: 'key', w: 1, h: 1, weight: 0.05, value: 900, stack: 1, rarity: 'rare', icon: 'key', desc: 'Unlocks the Radio Hill Hatch extract.', opens: 'x-hatch' },
  { id: 'key_lift', name: 'Cargo Lift Fob', cat: 'key', w: 1, h: 1, weight: 0.05, value: 700, stack: 1, rarity: 'uncommon', icon: 'key', desc: 'Calls the Yard Cargo Lift.', opens: 'x-lift' },
  { id: 'keycard', name: 'Security Keycard', cat: 'key', w: 1, h: 1, weight: 0.02, value: 1200, stack: 1, rarity: 'epic', icon: 'keycard', desc: 'Opens locked security lockers.', opens: 'locker' },
  // ---- Materials
  { id: 'scrap', name: 'Scrap Metal', cat: 'material', w: 1, h: 1, weight: 0.5, value: 20, stack: 20, rarity: 'common', icon: 'scrap', desc: 'Crafting material.' },
  { id: 'fabric', name: 'Fabric', cat: 'material', w: 1, h: 1, weight: 0.1, value: 18, stack: 20, rarity: 'common', icon: 'fabric', desc: 'Crafting material for meds.' },
  { id: 'chemicals', name: 'Chemicals', cat: 'material', w: 1, h: 1, weight: 0.3, value: 45, stack: 10, rarity: 'common', icon: 'chem', desc: 'Crafting material.' },
  { id: 'circuitry', name: 'Circuitry', cat: 'material', w: 1, h: 1, weight: 0.15, value: 70, stack: 10, rarity: 'uncommon', icon: 'chip', desc: 'Salvaged electronics.' },
  { id: 'battery', name: 'Battery', cat: 'material', w: 1, h: 1, weight: 0.4, value: 60, stack: 10, rarity: 'uncommon', icon: 'battery', desc: 'Stores charge. Crafts cells.' },
  { id: 'rare_alloy', name: 'Rare Alloy', cat: 'material', w: 1, h: 1, weight: 0.8, value: 240, stack: 5, rarity: 'rare', icon: 'alloy', desc: 'High-grade metal.' },
  { id: 'arc_servo', name: 'ARC Servo', cat: 'material', w: 1, h: 1, weight: 0.7, value: 180, stack: 5, rarity: 'uncommon', icon: 'servo', desc: 'Actuator pulled from an ARC unit.' },
  // ---- Valuables
  { id: 'arc_optic', name: 'ARC Optic', cat: 'valuable', w: 1, h: 1, weight: 0.3, value: 520, stack: 3, rarity: 'rare', icon: 'optic', desc: 'Sensor lens from a machine. Traders pay well.' },
  { id: 'arc_core', name: 'ARC Core', cat: 'valuable', w: 2, h: 2, weight: 2.2, value: 1800, stack: 1, rarity: 'epic', icon: 'core', desc: 'Still humming. Extremely valuable.' },
  { id: 'watch', name: 'Pocket Watch', cat: 'valuable', w: 1, h: 1, weight: 0.1, value: 260, stack: 3, rarity: 'uncommon', icon: 'watch', desc: 'Sell for credits.' },
  { id: 'data_drive', name: 'Data Drive', cat: 'valuable', w: 1, h: 1, weight: 0.05, value: 420, stack: 5, rarity: 'rare', icon: 'drive', desc: 'Pre-fall data. Sell for credits.' },
  { id: 'old_camera', name: 'Old Camera', cat: 'valuable', w: 2, h: 1, weight: 0.7, value: 340, stack: 1, rarity: 'uncommon', icon: 'camera', desc: 'Sell for credits.' },
  { id: 'relay_board', name: 'Relay Board', cat: 'valuable', w: 2, h: 1, weight: 0.6, value: 380, stack: 2, rarity: 'uncommon', icon: 'relay', desc: 'Sell for credits.' },
  { id: 'gold_idol', name: 'Gilded Idol', cat: 'valuable', w: 1, h: 2, weight: 1.4, value: 2600, stack: 1, rarity: 'legendary', icon: 'idol', desc: 'A collector will pay a fortune.' },
);

export const ITEMS: Record<string, ItemDef> = Object.fromEntries(defs.map((d) => [d.id, d]));

export const THROWABLE_IDS = ['frag', 'emp', 'smoke', 'decoy', 'mine'] as const;

export function itemDef(id: string): ItemDef {
  const d = ITEMS[id];
  if (!d) throw new Error(`Unknown item ${id}`);
  return d;
}

export function weaponItemId(weaponId: string): string {
  return `wpn_${weaponId}`;
}

export function ammoItemId(t: AmmoType): string {
  return `ammo_${t}`;
}

export function stackRarity(s: ItemStack): Rarity {
  return s.rarity ?? itemDef(s.id).rarity;
}

export function rarityColor(r: Rarity): string {
  return RARITY[r].color;
}

/** Credit value of a whole stack. */
export function stackValue(s: ItemStack): number {
  const d = itemDef(s.id);
  const mult = d.cat === 'weapon' ? RARITY_VALUE[stackRarity(s)] : 1;
  return Math.round(d.value * mult * s.qty);
}

export function stackWeight(s: ItemStack): number {
  return itemDef(s.id).weight * s.qty;
}

export function makeStack(id: string, qty = 1, extra: Partial<ItemStack> = {}): ItemStack {
  const d = itemDef(id);
  const s: ItemStack = { uid: newUid(), id, qty: Math.max(1, Math.min(qty, d.stack)), x: 0, y: 0, ...extra };
  if (d.cat === 'weapon' && !s.rarity) s.rarity = 'common';
  if (d.cat === 'weapon' && s.mag === undefined) s.mag = 0;
  return s;
}

export function cloneStack(s: ItemStack): ItemStack {
  return { ...s, uid: newUid() };
}

/** Quick-use a throwable. W4 implements the behaviour; this is the contract. */
export function useQuickItem(id: string): void {
  Events.emit('throwable:use', { id });
}
