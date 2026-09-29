import { Events } from '../core/Events';
import { AmmoPouch } from '../weapons/Weapon';
import type { AmmoType } from '../weapons/WeaponDefs';
import {
  ammoItemId, bumpUid, itemDef, makeStack, stackValue, stackWeight, type ItemCategory, type ItemStack,
} from './Items';

/** Tetris-style item grid (backpack, stash, container). */
export class Grid {
  items: ItemStack[] = [];
  /** Bumped on every mutation (UI diffing). */
  version = 0;

  constructor(
    public w: number,
    public h: number,
    public label = '',
  ) {}

  touch(): void {
    this.version++;
  }

  at(x: number, y: number): ItemStack | undefined {
    for (const s of this.items) {
      const d = itemDef(s.id);
      if (x >= s.x && x < s.x + d.w && y >= s.y && y < s.y + d.h) return s;
    }
    return undefined;
  }

  /** Can a w×h footprint sit at x,y ignoring `ignore`? */
  fits(w: number, h: number, x: number, y: number, ignore?: ItemStack): boolean {
    if (x < 0 || y < 0 || x + w > this.w || y + h > this.h) return false;
    for (const s of this.items) {
      if (s === ignore) continue;
      const d = itemDef(s.id);
      if (x < s.x + d.w && x + w > s.x && y < s.y + d.h && y + h > s.y) return false;
    }
    return true;
  }

  canPlace(s: ItemStack, x: number, y: number, ignore?: ItemStack): boolean {
    const d = itemDef(s.id);
    return this.fits(d.w, d.h, x, y, ignore);
  }

  place(s: ItemStack, x: number, y: number): boolean {
    if (!this.canPlace(s, x, y)) return false;
    s.x = x;
    s.y = y;
    this.items.push(s);
    this.touch();
    return true;
  }

  remove(s: ItemStack): boolean {
    const i = this.items.indexOf(s);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.touch();
    return true;
  }

  findSpot(s: ItemStack): [number, number] | null {
    const d = itemDef(s.id);
    for (let y = 0; y <= this.h - d.h; y++) for (let x = 0; x <= this.w - d.w; x++) if (this.fits(d.w, d.h, x, y)) return [x, y];
    return null;
  }

  /** Merge into existing stacks, then place the remainder. Returns quantity that did not fit. */
  add(s: ItemStack): number {
    const d = itemDef(s.id);
    let left = s.qty;
    if (d.stack > 1) {
      for (const o of this.items) {
        if (o.id !== s.id || o.qty >= d.stack) continue;
        const n = Math.min(left, d.stack - o.qty);
        o.qty += n;
        left -= n;
        if (left <= 0) break;
      }
    }
    while (left > 0) {
      const spot = this.findSpot(s);
      if (!spot) break;
      if (left <= d.stack) {
        // The original stack object goes in (keeps uid / weapon state)
        s.qty = left;
        this.place(s, spot[0], spot[1]);
        left = 0;
      } else {
        this.place({ ...s, uid: makeStack(s.id).uid, qty: d.stack }, spot[0], spot[1]);
        left -= d.stack;
      }
    }
    this.touch();
    if (left > 0) s.qty = left;
    return left;
  }

  count(id: string): number {
    let n = 0;
    for (const s of this.items) if (s.id === id) n += s.qty;
    return n;
  }

  /** Remove up to n units of id (smallest stacks first). Returns units taken. */
  take(id: string, n: number): number {
    let got = 0;
    const stacks = this.items.filter((s) => s.id === id).sort((a, b) => a.qty - b.qty);
    for (const s of stacks) {
      const k = Math.min(n - got, s.qty);
      s.qty -= k;
      got += k;
      if (s.qty <= 0) this.remove(s);
      if (got >= n) break;
    }
    if (got) this.touch();
    return got;
  }

  clear(): void {
    this.items.length = 0;
    this.touch();
  }

  weight(): number {
    return this.items.reduce((a, s) => a + stackWeight(s), 0);
  }

  value(): number {
    return this.items.reduce((a, s) => a + stackValue(s), 0);
  }

  serialize(): ItemStack[] {
    return this.items.map((s) => ({ ...s }));
  }

  load(items: ItemStack[]): void {
    this.items = [];
    for (const s of items) {
      if (!safeDef(s.id)) continue;
      bumpUid(s.uid);
      if (!this.place({ ...s }, s.x, s.y)) this.add({ ...s });
    }
    this.touch();
  }
}

function safeDef(id: string): boolean {
  try {
    itemDef(id);
    return true;
  } catch {
    return false;
  }
}

export type SlotId = 'w0' | 'w1' | 'shield' | 'q0' | 'q1' | 'q2' | 'q3';
export const SLOT_IDS: SlotId[] = ['w0', 'w1', 'shield', 'q0', 'q1', 'q2', 'q3'];
export const QUICK_SLOTS: SlotId[] = ['q0', 'q1', 'q2', 'q3'];

const SLOT_ACCEPTS: Record<SlotId, ItemCategory[]> = {
  w0: ['weapon'], w1: ['weapon'], shield: ['shield'],
  q0: ['med', 'throwable'], q1: ['med', 'throwable'], q2: ['med', 'throwable'], q3: ['med', 'throwable'],
};

export interface SavedLoadout {
  backpack: ItemStack[];
  slots: Partial<Record<SlotId, ItemStack | null>>;
}

/** Player loadout: equipment slots + backpack grid. Weight drives encumbrance. */
export class Inventory {
  readonly backpack = new Grid(6, 5, 'Backpack');
  readonly slots: Record<SlotId, ItemStack | null> = { w0: null, w1: null, shield: null, q0: null, q1: null, q2: null, q3: null };
  version = 0;
  /** Carry weight where encumbrance begins / maxes out (kg). */
  static readonly LIGHT = 18;
  static readonly HEAVY = 42;

  accepts(slot: SlotId, s: ItemStack): boolean {
    return SLOT_ACCEPTS[slot].includes(itemDef(s.id).cat);
  }

  changed(): void {
    this.version++;
    this.backpack.touch();
    Events.emit('inv:changed', this);
  }

  setSlot(slot: SlotId, s: ItemStack | null): void {
    this.slots[slot] = s;
    this.changed();
  }

  /** All carried stacks (backpack + equipment). */
  all(): ItemStack[] {
    const out = [...this.backpack.items];
    for (const id of SLOT_IDS) if (this.slots[id]) out.push(this.slots[id]!);
    return out;
  }

  weight(): number {
    return this.all().reduce((a, s) => a + stackWeight(s), 0);
  }

  value(): number {
    return this.all().reduce((a, s) => a + stackValue(s), 0);
  }

  /** 0..1 movement penalty from weight. */
  encumbrance(): number {
    const w = this.weight();
    return Math.max(0, Math.min(1, (w - Inventory.LIGHT) / (Inventory.HEAVY - Inventory.LIGHT)));
  }

  count(id: string): number {
    let n = this.backpack.count(id);
    for (const q of QUICK_SLOTS) if (this.slots[q]?.id === id) n += this.slots[q]!.qty;
    return n;
  }

  /** Consume n units of id, quick slots first. */
  consume(id: string, n = 1): number {
    let got = 0;
    for (const q of QUICK_SLOTS) {
      const s = this.slots[q];
      if (!s || s.id !== id || got >= n) continue;
      const k = Math.min(n - got, s.qty);
      s.qty -= k;
      got += k;
      if (s.qty <= 0) this.slots[q] = null;
    }
    if (got < n) got += this.backpack.take(id, n - got);
    if (got) this.changed();
    return got;
  }

  has(id: string): boolean {
    return this.count(id) > 0;
  }

  /** Auto-add to the backpack (merging). Returns leftover quantity. */
  add(s: ItemStack): number {
    const left = this.backpack.add(s);
    this.changed();
    return left;
  }

  ammoCount(t: AmmoType): number {
    return this.backpack.count(ammoItemId(t));
  }

  takeAmmo(t: AmmoType, n: number): number {
    const got = this.backpack.take(ammoItemId(t), n);
    if (got) this.changed();
    return got;
  }

  /** Throwable ids present in quick slots, in slot order. */
  quickThrowables(): SlotId[] {
    return QUICK_SLOTS.filter((q) => this.slots[q] && itemDef(this.slots[q]!.id).cat === 'throwable');
  }

  clear(): void {
    this.backpack.clear();
    for (const id of SLOT_IDS) this.slots[id] = null;
    this.changed();
  }

  serialize(): SavedLoadout {
    const slots: SavedLoadout['slots'] = {};
    for (const id of SLOT_IDS) slots[id] = this.slots[id] ? { ...this.slots[id]! } : null;
    return { backpack: this.backpack.serialize(), slots };
  }

  load(l: SavedLoadout | undefined): void {
    this.backpack.load(l?.backpack ?? []);
    for (const id of SLOT_IDS) {
      const s = l?.slots?.[id];
      this.slots[id] = s && safeDef(s.id) ? { ...s } : null;
      if (s) bumpUid(s.uid);
    }
    this.changed();
  }

  /** Starter kit for a fresh profile. */
  static starter(): SavedLoadout {
    const inv = new Inventory();
    inv.slots.w0 = makeStack('wpn_mako', 1, { rarity: 'common', mag: 30 });
    inv.slots.w1 = makeStack('wpn_pip', 1, { rarity: 'common', mag: 15 });
    inv.slots.shield = makeStack('shield_light', 1, { charge: 40 });
    inv.slots.q0 = makeStack('bandage', 2);
    inv.slots.q1 = makeStack('shield_cell', 1);
    inv.slots.q2 = makeStack('frag', 1);
    inv.backpack.add(makeStack('ammo_medium', 90));
    inv.backpack.add(makeStack('ammo_medium', 60));
    inv.backpack.add(makeStack('ammo_light', 60));
    return inv.serialize();
  }
}

/** AmmoPouch whose reserve is the ammo carried in the backpack. */
export class InventoryPouch extends AmmoPouch {
  constructor(private inv: Inventory) {
    super();
  }

  count(t: AmmoType): number {
    return this.infinite ? 9999 : this.inv.ammoCount(t);
  }

  take(t: AmmoType, n: number): number {
    if (this.infinite) return n;
    return this.inv.takeAmmo(t, n);
  }
}
