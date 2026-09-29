import { Events } from '../core/Events';
import { Grid, Inventory, type SavedLoadout } from './Inventory';
import { itemDef, makeStack, stackValue, type ItemStack } from './Items';
import { weaponStack } from './LootTables';

/**
 * Persistent profile: stash grid, current raid loadout, credits and stats.
 * Stored in localStorage under a versioned key; every access is try/catch'd.
 */

const KEY = 'rustfall.profile.v1';

export interface RaidStats {
  raids: number;
  extracted: number;
  died: number;
  mia: number;
  kills: number;
}

interface ProfileData {
  version: 1;
  credits: number;
  stash: ItemStack[];
  loadout: SavedLoadout;
  inRaid: boolean;
  stats: RaidStats;
}

export interface Recipe {
  id: string;
  out: { id: string; qty: number };
  cost: { id: string; qty: number }[];
}

export const RECIPES: Recipe[] = [
  { id: 'r-light', out: { id: 'ammo_light', qty: 40 }, cost: [{ id: 'scrap', qty: 2 }] },
  { id: 'r-medium', out: { id: 'ammo_medium', qty: 30 }, cost: [{ id: 'scrap', qty: 3 }] },
  { id: 'r-heavy', out: { id: 'ammo_heavy', qty: 15 }, cost: [{ id: 'scrap', qty: 3 }, { id: 'chemicals', qty: 1 }] },
  { id: 'r-shells', out: { id: 'ammo_shells', qty: 12 }, cost: [{ id: 'scrap', qty: 2 }, { id: 'chemicals', qty: 1 }] },
  { id: 'r-cells', out: { id: 'ammo_cells', qty: 80 }, cost: [{ id: 'battery', qty: 1 }, { id: 'circuitry', qty: 1 }] },
  { id: 'r-bandage', out: { id: 'bandage', qty: 2 }, cost: [{ id: 'fabric', qty: 3 }] },
  { id: 'r-medkit', out: { id: 'medkit', qty: 1 }, cost: [{ id: 'fabric', qty: 3 }, { id: 'chemicals', qty: 2 }] },
  { id: 'r-cell', out: { id: 'shield_cell', qty: 1 }, cost: [{ id: 'battery', qty: 1 }, { id: 'circuitry', qty: 1 }] },
  { id: 'r-frag', out: { id: 'frag', qty: 1 }, cost: [{ id: 'scrap', qty: 2 }, { id: 'chemicals', qty: 2 }] },
];

export interface Offer {
  id: string;
  name: string;
  desc: string;
  price: number;
  items: () => ItemStack[];
}

export const OFFERS: Offer[] = [
  { id: 'o-bandage', name: 'Bandage ×2', desc: 'Two field bandages.', price: 220, items: () => [makeStack('bandage', 2)] },
  { id: 'o-cell', name: 'Shield Cell', desc: 'Restores 40 shield.', price: 420, items: () => [makeStack('shield_cell', 1)] },
  { id: 'o-light', name: 'Light Ammo ×60', desc: 'SMGs and pistols.', price: 120, items: () => [makeStack('ammo_light', 60)] },
  { id: 'o-medium', name: 'Medium Ammo ×60', desc: 'Rifles and LMGs.', price: 180, items: () => [makeStack('ammo_medium', 60)] },
  { id: 'o-heavy', name: 'Heavy Ammo ×20', desc: 'Battle rifles, marksman.', price: 160, items: () => [makeStack('ammo_heavy', 20)] },
  { id: 'o-shells', name: 'Shells ×20', desc: 'Shotguns.', price: 150, items: () => [makeStack('ammo_shells', 20)] },
  { id: 'o-frag', name: 'Frag Grenade', desc: 'One frag grenade.', price: 480, items: () => [makeStack('frag', 1)] },
  { id: 'o-shield', name: 'Light Shield', desc: '40 shield capacity.', price: 950, items: () => [makeStack('shield_light', 1, { charge: 40 })] },
  {
    id: 'o-scav', name: 'Scavenger Kit', desc: 'Pip pistol, 60 light rounds, 2 bandages.', price: 900,
    items: () => [weaponStack('pip', 'common', true), makeStack('ammo_light', 60), makeStack('bandage', 2)],
  },
  {
    id: 'o-assault', name: 'Assault Kit', desc: 'Mako AR, 120 medium, med kit, shield cell.', price: 3400,
    items: () => [weaponStack('mako', 'common', true), makeStack('ammo_medium', 90), makeStack('ammo_medium', 30), makeStack('medkit', 1), makeStack('shield_cell', 1)],
  },
];

/** Sell price: valuables at full value, everything else at 45%. */
export function sellPrice(s: ItemStack): number {
  const k = itemDef(s.id).cat === 'valuable' ? 1 : 0.45;
  return Math.max(1, Math.round(stackValue(s) * k));
}

export class Profile {
  readonly stash = new Grid(10, 16, 'Stash');
  readonly loadout = new Inventory();
  credits = 1500;
  inRaid = false;
  stats: RaidStats = { raids: 0, extracted: 0, died: 0, mia: 0, kills: 0 };
  /** Set when a raid was interrupted by a reload (loadout forfeited). */
  forfeited = false;

  static load(): Profile {
    const p = new Profile();
    let data: ProfileData | null = null;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) data = JSON.parse(raw) as ProfileData;
    } catch {
      data = null;
    }
    if (data && data.version === 1) {
      p.credits = data.credits ?? 0;
      p.stats = { ...p.stats, ...(data.stats ?? {}) };
      p.stash.load(data.stash ?? []);
      p.loadout.load(data.loadout);
      if (data.inRaid) {
        // Closed the tab mid-raid: the kit is lost, like any MIA.
        p.loadout.clear();
        p.stats.mia++;
        p.forfeited = true;
        p.save();
      }
    } else {
      p.loadout.load(Inventory.starter());
      p.stash.add(makeStack('scrap', 8));
      p.stash.add(makeStack('fabric', 6));
      p.stash.add(makeStack('bandage', 2));
      p.stash.add(makeStack('ammo_light', 60));
      p.save();
    }
    return p;
  }

  save(): void {
    const data: ProfileData = {
      version: 1,
      credits: this.credits,
      stash: this.stash.serialize(),
      loadout: this.loadout.serialize(),
      inRaid: this.inRaid,
      stats: this.stats,
    };
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      // storage full / blocked: progress is kept in memory only
    }
    Events.emit('profile:changed', this);
  }

  /** Total stock of an item across stash (crafting uses the stash only). */
  stock(id: string): number {
    return this.stash.count(id);
  }

  canCraft(r: Recipe): boolean {
    return r.cost.every((c) => this.stock(c.id) >= c.qty);
  }

  craft(r: Recipe): boolean {
    if (!this.canCraft(r)) return false;
    const out = makeStack(r.out.id, r.out.qty);
    // Check space before paying
    const probe = new Grid(this.stash.w, this.stash.h);
    probe.load(this.stash.serialize());
    for (const c of r.cost) probe.take(c.id, c.qty);
    if (probe.add({ ...out }) > 0) {
      Events.emit('toast', 'Stash is full');
      return false;
    }
    for (const c of r.cost) this.stash.take(c.id, c.qty);
    this.stash.add(out);
    this.save();
    return true;
  }

  sell(s: ItemStack): number {
    if (!this.stash.remove(s)) return 0;
    const price = sellPrice(s);
    this.credits += price;
    this.save();
    return price;
  }

  buy(o: Offer): boolean {
    if (this.credits < o.price) return false;
    const items = o.items();
    const probe = new Grid(this.stash.w, this.stash.h);
    probe.load(this.stash.serialize());
    for (const it of items) if (probe.add({ ...it }) > 0) {
      Events.emit('toast', 'Stash is full');
      return false;
    }
    for (const it of items) this.stash.add(it);
    this.credits -= o.price;
    this.save();
    return true;
  }

  /** Extracted: backpack → stash (overflow stays in the backpack), equipment stays equipped. */
  bankBackpack(): number {
    let moved = 0;
    for (const s of [...this.loadout.backpack.items]) {
      this.loadout.backpack.remove(s);
      const v = stackValue(s);
      const left = this.stash.add(s);
      if (left > 0) {
        moved += v - stackValue(s);
        this.loadout.backpack.add(s);
      } else moved += v;
    }
    this.loadout.changed();
    return moved;
  }
}
