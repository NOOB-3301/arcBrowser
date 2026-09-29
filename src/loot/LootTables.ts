import type { Rarity } from '../weapons/WeaponDefs';
import { WEAPONS } from '../weapons/WeaponDefs';
import { ammoItemId, itemDef, makeStack, RARITY_ORDER, weaponItemId, type ItemStack } from './Items';

/** Weighted entry: item id (or 'weapon:*' for a random roster weapon) and quantity range. */
export interface LootEntry {
  id: string;
  w: number;
  min?: number;
  max?: number;
}

export interface LootTable {
  /** Number of rolls [min, max]. */
  rolls: [number, number];
  entries: LootEntry[];
  /** Weapon rarity weights (common → legendary). */
  rarity?: number[];
}

export type ContainerType = 'crate' | 'locker' | 'medcab' | 'toolbox' | 'wreck' | 'body' | 'cache' | 'drop';

const AMMO: LootEntry[] = [
  { id: 'ammo_light', w: 10, min: 20, max: 60 },
  { id: 'ammo_medium', w: 10, min: 20, max: 60 },
  { id: 'ammo_heavy', w: 6, min: 8, max: 24 },
  { id: 'ammo_shells', w: 5, min: 6, max: 18 },
  { id: 'ammo_cells', w: 3, min: 40, max: 120 },
];

const MATS: LootEntry[] = [
  { id: 'scrap', w: 16, min: 1, max: 5 },
  { id: 'fabric', w: 10, min: 1, max: 4 },
  { id: 'chemicals', w: 6, min: 1, max: 3 },
  { id: 'circuitry', w: 5, min: 1, max: 2 },
  { id: 'battery', w: 5, min: 1, max: 2 },
  { id: 'rare_alloy', w: 1.5 },
];

const VALUABLES: LootEntry[] = [
  { id: 'watch', w: 4 },
  { id: 'data_drive', w: 3 },
  { id: 'old_camera', w: 3 },
  { id: 'relay_board', w: 3 },
  { id: 'gold_idol', w: 0.4 },
];

const MEDS: LootEntry[] = [
  { id: 'bandage', w: 10, min: 1, max: 3 },
  { id: 'medkit', w: 4 },
  { id: 'shield_cell', w: 6, min: 1, max: 2 },
];

const THROWABLES: LootEntry[] = [
  { id: 'frag', w: 4 },
  { id: 'smoke', w: 4 },
  { id: 'decoy', w: 3 },
  { id: 'emp', w: 2 },
  { id: 'mine', w: 2 },
];

const scale = (list: LootEntry[], k: number): LootEntry[] => list.map((e) => ({ ...e, w: e.w * k }));

/** Container tables by type; tier (1..3) scales rolls and rarity. */
export function containerTable(type: ContainerType, tier: number): LootTable {
  const t = Math.max(1, Math.min(3, tier));
  const rarity = t === 1 ? [60, 30, 9, 1, 0] : t === 2 ? [42, 34, 18, 5, 1] : [28, 32, 26, 11, 3];
  switch (type) {
    case 'locker':
      return {
        rolls: [2 + (t > 2 ? 1 : 0), 3 + t],
        rarity,
        entries: [{ id: 'weapon:*', w: 10 + t * 3 }, ...scale(AMMO, 1.4), { id: 'shield_light', w: 2 }, { id: 'shield_medium', w: t * 0.8 }, ...scale(THROWABLES, 0.8)],
      };
    case 'medcab':
      return { rolls: [1, 2 + t], rarity, entries: [...scale(MEDS, 2), { id: 'chemicals', w: 4 }, { id: 'fabric', w: 4, min: 1, max: 3 }] };
    case 'toolbox':
      return { rolls: [2, 3 + t], rarity, entries: [...scale(MATS, 2), { id: 'key_lift', w: 0.6 }, { id: 'key_hatch', w: 0.3 * t }, { id: 'relay_board', w: 2 }] };
    case 'cache':
      return {
        rolls: [3, 5],
        rarity: [5, 20, 40, 25, 10],
        entries: [{ id: 'weapon:*', w: 12 }, { id: 'shield_medium', w: 4 }, { id: 'shield_heavy', w: 1.5 }, ...VALUABLES, { id: 'rare_alloy', w: 4 }, { id: 'arc_core', w: 1 }, ...THROWABLES],
      };
    case 'crate':
    default:
      return {
        rolls: [1 + (t > 1 ? 1 : 0), 2 + t],
        rarity,
        entries: [
          ...MATS, ...scale(AMMO, 0.8), ...scale(MEDS, 0.7), ...scale(VALUABLES, 0.4 + t * 0.35), ...scale(THROWABLES, 0.4),
          { id: 'weapon:*', w: 1 + t }, { id: 'keycard', w: 0.15 * t }, { id: 'key_hatch', w: 0.15 * t },
        ],
      };
  }
}

/** ARC unit drops, by bot kind (future kinds included for W-series units). */
export const ARC_TABLES: Record<string, LootTable> = {
  tick: { rolls: [1, 2], entries: [{ id: 'scrap', w: 10, min: 1, max: 3 }, { id: 'battery', w: 3 }, { id: 'arc_servo', w: 2 }] },
  wasp: { rolls: [2, 3], entries: [{ id: 'scrap', w: 8, min: 2, max: 4 }, { id: 'arc_servo', w: 5 }, { id: 'circuitry', w: 5 }, { id: 'arc_optic', w: 3 }, { id: 'battery', w: 4 }, { id: 'ammo_cells', w: 3, min: 40, max: 100 }] },
  sentinel: { rolls: [3, 4], entries: [{ id: 'arc_optic', w: 6 }, { id: 'circuitry', w: 6, min: 1, max: 3 }, { id: 'rare_alloy', w: 4 }, { id: 'arc_servo', w: 4 }, { id: 'arc_core', w: 1.5 }, { id: 'ammo_heavy', w: 3, min: 10, max: 30 }] },
  stalker: { rolls: [2, 4], entries: [{ id: 'arc_servo', w: 6, min: 1, max: 2 }, { id: 'arc_optic', w: 4 }, { id: 'rare_alloy', w: 3 }, { id: 'battery', w: 4 }, { id: 'arc_core', w: 1 }] },
  colossus: { rolls: [5, 7], entries: [{ id: 'arc_core', w: 6 }, { id: 'rare_alloy', w: 6, min: 1, max: 3 }, { id: 'arc_optic', w: 5, min: 1, max: 2 }, { id: 'circuitry', w: 5, min: 2, max: 4 }, { id: 'gold_idol', w: 0.5 }] },
};

// ---------------------------------------------------------------- rolling

function pick<T extends { w: number }>(list: T[]): T {
  let total = 0;
  for (const e of list) total += e.w;
  let r = Math.random() * total;
  for (const e of list) {
    r -= e.w;
    if (r <= 0) return e;
  }
  return list[list.length - 1];
}

function rollRarity(weights: number[] = [55, 30, 12, 3, 0]): Rarity {
  const list = RARITY_ORDER.map((r, i) => ({ r, w: weights[i] ?? 0 }));
  return pick(list).r;
}

const WEAPON_IDS = Object.keys(WEAPONS);

export function randomWeapon(rarity: Rarity): ItemStack {
  const wid = WEAPON_IDS[Math.floor(Math.random() * WEAPON_IDS.length)];
  return weaponStack(wid, rarity, Math.random() < 0.5);
}

export function weaponStack(weaponId: string, rarity: Rarity, loaded: boolean): ItemStack {
  const def = WEAPONS[weaponId];
  const mag = def.heatPerShot !== undefined ? 0 : loaded ? Math.round(def.magSize * 0.6) : 0;
  return makeStack(weaponItemId(weaponId), 1, { rarity, mag });
}

export function rollTable(t: LootTable): ItemStack[] {
  const n = t.rolls[0] + Math.floor(Math.random() * (t.rolls[1] - t.rolls[0] + 1));
  const out: ItemStack[] = [];
  for (let i = 0; i < n; i++) {
    const e = pick(t.entries);
    if (e.id === 'weapon:*') {
      out.push(randomWeapon(rollRarity(t.rarity)));
      continue;
    }
    const qty = e.min !== undefined ? e.min + Math.floor(Math.random() * ((e.max ?? e.min) - e.min + 1)) : 1;
    out.push(makeStack(e.id, Math.min(qty, itemDef(e.id).stack)));
  }
  return out;
}

/** Raider corpse: their weapon, some matching ammo, maybe meds. */
export function raiderDrop(weaponId: string | undefined, rarity: Rarity | undefined): ItemStack[] {
  const out: ItemStack[] = [];
  if (weaponId && WEAPONS[weaponId]) {
    out.push(weaponStack(weaponId, rarity ?? 'common', true));
    const ammo = WEAPONS[weaponId].ammo;
    const q = { light: 45, medium: 40, heavy: 16, shells: 12, cells: 90 }[ammo];
    out.push(makeStack(ammoItemId(ammo), Math.round(q * (0.6 + Math.random() * 0.8))));
  }
  if (Math.random() < 0.7) out.push(makeStack('bandage', 1 + Math.floor(Math.random() * 2)));
  if (Math.random() < 0.35) out.push(makeStack('shield_cell', 1));
  if (Math.random() < 0.25) out.push(makeStack(Math.random() < 0.6 ? 'frag' : 'smoke', 1));
  out.push(...rollTable({ rolls: [0, 2], entries: [...MATS, ...VALUABLES] }));
  return out;
}
