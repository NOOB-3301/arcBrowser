import { Grid, Inventory, SLOT_IDS, type SlotId } from '../loot/Inventory';
import { itemDef, newUid, rarityColor, stackRarity, stackValue, stackWeight, type ItemStack } from '../loot/Items';
import { iconSvg } from '../loot/Icons';
import { AMMO_LABEL, RARITY, WEAPONS } from '../weapons/WeaponDefs';
import type { PadNav } from './PadNav';

/**
 * Drag-and-drop inventory board: an equipment column plus any number of item
 * grids (backpack, container, stash). Mouse: drag, right-click quick-move,
 * shift-drag split, Del discard, double-click equip. Gamepad: cursor with
 * A take/place, X quick-move, Y discard, RB split, B cancel/close.
 */

export interface GridPanelSpec {
  kind: 'grid';
  grid: Grid;
  title: string;
  role: 'backpack' | 'container' | 'stash';
  /** Rendered inside a scroll box. */
  scroll?: boolean;
  subtitle?: string;
}
export type PanelSpec = GridPanelSpec | { kind: 'equip' } | { kind: 'empty'; title: string; text: string };

type Loc =
  | { kind: 'grid'; grid: Grid; x: number; y: number }
  | { kind: 'slot'; slot: SlotId }
  | { kind: 'split'; of: ItemStack };

interface Held {
  stack: ItemStack;
  origin: Loc;
  /** Grab offset inside the item (cells). */
  ox: number;
  oy: number;
}

export interface BoardOptions {
  inv: Inventory;
  panels: PanelSpec[];
  /** Discard (raid: drop to ground; stash: sell). Return false to refuse. */
  onDiscard(stack: ItemStack, from: Loc): boolean;
  discardLabel: string;
  onChange(): void;
  /** Close request (B on pad with nothing held). */
  onClose?(): void;
}

const SLOT_LABEL: Record<SlotId, string> = {
  w0: 'Primary', w1: 'Secondary', shield: 'Shield', q0: 'Q1', q1: 'Q2', q2: 'Q3', q3: 'Q4',
};
/** Equipment cursor layout (rows of slot ids) for pad navigation. */
const EQUIP_ROWS: SlotId[][] = [['w0'], ['w1'], ['shield'], ['q0', 'q1', 'q2', 'q3']];

interface Cursor {
  p: number;
  x: number;
  y: number;
}

export class InvBoard {
  readonly el: HTMLElement;
  private panels: PanelSpec[];
  private gridEls = new Map<number, HTMLElement>();
  private held: Held | null = null;
  private ghost: HTMLElement;
  private details: HTMLElement | null = null;
  private hovered: { stack: ItemStack; loc: Loc } | null = null;
  private cursor: Cursor | null = null;
  private cursorEl: HTMLElement;
  private mouse = { x: 0, y: 0 };
  private lastRender = '';
  private disposed = false;

  constructor(private o: BoardOptions) {
    this.panels = o.panels;
    this.el = document.createElement('div');
    this.el.className = 'invb';
    this.ghost = document.createElement('div');
    this.ghost.className = 'invb-ghost';
    this.cursorEl = document.createElement('div');
    this.cursorEl.className = 'invb-cursor';
    this.bindMouse();
    this.render();
  }

  setPanels(panels: PanelSpec[]): void {
    this.cancelHeld();
    this.panels = panels;
    if (this.cursor && this.cursor.p >= panels.length) this.cursor = null;
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelHeld();
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('keydown', this.onKey);
    this.ghost.remove();
    this.el.remove();
  }

  // ================================================================ render

  /** Re-render if any model changed (cheap signature check). */
  refresh(): void {
    const sig = this.signature();
    if (sig !== this.lastRender) this.render();
  }

  private signature(): string {
    const parts = [String(this.o.inv.version), String(this.o.inv.backpack.version)];
    for (const p of this.panels) if (p.kind === 'grid') parts.push(`${p.grid.version}:${p.grid.items.length}`);
    for (const id of SLOT_IDS) parts.push(`${this.o.inv.slots[id]?.uid ?? 0}:${this.o.inv.slots[id]?.qty ?? 0}`);
    return parts.join('|');
  }

  render(): void {
    if (this.disposed) return;
    this.lastRender = this.signature();
    this.gridEls.clear();
    this.el.innerHTML = '';
    this.panels.forEach((p, i) => {
      const col = document.createElement('section');
      col.className = `invb-panel invb-${p.kind === 'grid' ? p.role : p.kind}`;
      if (p.kind === 'equip') col.appendChild(this.renderEquip());
      else if (p.kind === 'empty') col.innerHTML = `<header><h3>${p.title}</h3></header><div class="invb-empty">${p.text}</div>`;
      else col.appendChild(this.renderGrid(p, i));
      this.el.appendChild(col);
    });
    this.el.appendChild(this.cursorEl);
    this.drawCursor();
    this.updateDetails();
  }

  private renderEquip(): HTMLElement {
    const inv = this.o.inv;
    const wrap = document.createElement('div');
    const w = inv.weight();
    const val = inv.value();
    wrap.innerHTML = `<header><h3>Equipment</h3><small>${val.toLocaleString()} cr</small></header>`;
    const body = document.createElement('div');
    body.className = 'invb-equip';
    for (const row of EQUIP_ROWS) {
      const r = document.createElement('div');
      r.className = 'invb-row';
      for (const id of row) r.appendChild(this.renderSlot(id));
      body.appendChild(r);
    }
    wrap.appendChild(body);
    const weight = document.createElement('div');
    const frac = Math.min(1, w / Inventory.HEAVY);
    const cls = w > Inventory.HEAVY ? 'over' : w > Inventory.LIGHT ? 'heavy' : '';
    weight.className = `invb-weight ${cls}`;
    weight.innerHTML = `<div class="invb-weight-top"><span>Weight</span><b>${w.toFixed(1)} / ${Inventory.HEAVY} kg</b></div>
      <div class="invb-weight-bar"><i style="width:${(frac * 100).toFixed(1)}%"></i><em style="left:${((Inventory.LIGHT / Inventory.HEAVY) * 100).toFixed(1)}%"></em></div>`;
    wrap.appendChild(weight);
    this.details = document.createElement('div');
    this.details.className = 'invb-details';
    wrap.appendChild(this.details);
    return wrap;
  }

  private renderSlot(id: SlotId): HTMLElement {
    const s = this.o.inv.slots[id];
    const el = document.createElement('div');
    el.className = `invb-slot invb-slot-${id.startsWith('q') ? 'quick' : id}`;
    el.dataset.slot = id;
    if (s) {
      el.classList.add('filled');
      el.appendChild(this.itemEl(s, { kind: 'slot', slot: id }, true));
    } else {
      el.innerHTML = `<span class="invb-slot-label">${SLOT_LABEL[id]}</span>`;
    }
    return el;
  }

  private renderGrid(p: GridPanelSpec, index: number): HTMLElement {
    const wrap = document.createElement('div');
    const val = p.grid.value();
    wrap.innerHTML = `<header><h3>${p.title}</h3><small>${p.subtitle ?? `${val.toLocaleString()} cr`}</small></header>`;
    const scroller = document.createElement('div');
    scroller.className = p.scroll ? 'invb-scroll' : 'invb-noscroll';
    const g = document.createElement('div');
    g.className = 'invb-grid';
    g.style.setProperty('--gw', String(p.grid.w));
    g.style.setProperty('--gh', String(p.grid.h));
    g.dataset.panel = String(index);
    for (const s of p.grid.items) {
      const it = this.itemEl(s, { kind: 'grid', grid: p.grid, x: s.x, y: s.y }, false);
      const d = itemDef(s.id);
      it.style.left = `calc(var(--cell) * ${s.x} + 2px)`;
      it.style.top = `calc(var(--cell) * ${s.y} + 2px)`;
      it.style.width = `calc(var(--cell) * ${d.w} - 3px)`;
      it.style.height = `calc(var(--cell) * ${d.h} - 3px)`;
      g.appendChild(it);
    }
    this.gridEls.set(index, g);
    scroller.appendChild(g);
    wrap.appendChild(scroller);
    return wrap;
  }

  private itemEl(s: ItemStack, loc: Loc, inSlot: boolean): HTMLElement {
    const d = itemDef(s.id);
    const r = stackRarity(s);
    const el = document.createElement('div');
    el.className = `invb-item cat-${d.cat} ${d.w * d.h === 1 && !inSlot ? 'small' : ''}`;
    el.style.setProperty('--rc', rarityColor(r));
    const showName = !(d.w === 1 && d.h === 1) || inSlot;
    const qty = d.stack > 1 ? `<span class="it-qty">${s.qty}</span>` : '';
    const mag = d.cat === 'weapon' && s.mag !== undefined && WEAPONS[d.weaponId!]?.heatPerShot === undefined ? `<span class="it-qty">${s.mag}</span>` : '';
    el.innerHTML = `${iconSvg(d.icon)}${showName ? `<span class="it-name">${d.name}</span>` : ''}${qty || mag}`;
    el.addEventListener('pointerdown', (e) => this.onDown(e, s, loc));
    el.addEventListener('pointerenter', () => {
      this.hovered = { stack: s, loc };
      this.updateDetails();
    });
    el.addEventListener('pointerleave', () => {
      if (this.hovered?.stack === s) this.hovered = null;
      this.updateDetails();
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.held) this.quickMove(s, loc);
    });
    el.addEventListener('dblclick', () => {
      if (!this.held) this.quickMove(s, loc, true);
    });
    return el;
  }

  private updateDetails(): void {
    if (!this.details) return;
    const s = this.held?.stack ?? this.hovered?.stack ?? this.cursorStack()?.stack;
    if (!s) {
      this.details.innerHTML = `<div class="invb-hint">${this.hintText()}</div>`;
      return;
    }
    const d = itemDef(s.id);
    const r = stackRarity(s);
    let extra = '';
    if (d.cat === 'weapon' && d.weaponId) {
      const w = WEAPONS[d.weaponId];
      extra = `<div class="dt-stats"><span>${AMMO_LABEL[w.ammo]} ammo</span><span>${Math.round(w.damage * RARITY[r].damage)} dmg</span><span>${w.rpm} rpm</span></div>`;
    }
    this.details.innerHTML = `
      <div class="dt-name" style="color:${rarityColor(r)}">${d.name}</div>
      <div class="dt-meta"><span class="dt-rar" style="--rc:${rarityColor(r)}">${r}</span><span class="dt-cat">${d.cat}</span><span>${stackWeight(s).toFixed(1)} kg</span><span>${stackValue(s).toLocaleString()} cr</span></div>
      ${extra}<div class="dt-desc">${d.desc}</div>`;
  }

  private hintText(): string {
    return `<b>Drag</b> move · <b>Right-click</b> quick-move · <b>Shift+drag</b> split · <b>Del</b> ${this.o.discardLabel.toLowerCase()}<br>
      <span class="pad">Pad: <b>A</b> take/place · <b>X</b> quick-move · <b>RB</b> split · <b>Y</b> ${this.o.discardLabel.toLowerCase()} · <b>B</b> back</span>`;
  }

  // ================================================================ model ops

  private removeFrom(s: ItemStack, loc: Loc): void {
    if (loc.kind === 'grid') loc.grid.remove(s);
    else if (loc.kind === 'slot') this.o.inv.slots[loc.slot] = null;
  }

  /** Put a stack back where it came from (or anywhere in that grid). */
  private restore(h: Held): void {
    const { stack, origin } = h;
    if (origin.kind === 'split') {
      origin.of.qty += stack.qty;
    } else if (origin.kind === 'grid') {
      if (!origin.grid.place(stack, origin.x, origin.y)) origin.grid.add(stack);
    } else {
      const cur = this.o.inv.slots[origin.slot];
      if (!cur) this.o.inv.slots[origin.slot] = stack;
      else if (this.o.inv.backpack.add(stack) > 0) this.o.onDiscard(stack, origin);
    }
  }

  private cancelHeld(): void {
    if (!this.held) return;
    this.restore(this.held);
    this.held = null;
    this.ghost.remove();
    this.commit();
  }

  private commit(): void {
    this.o.inv.changed();
    this.o.onChange();
    this.render();
  }

  /** Try to drop held onto a grid at top-left x,y. */
  private dropGrid(grid: Grid, x: number, y: number): boolean {
    const h = this.held!;
    const d = itemDef(h.stack.id);
    // Merge onto a same-id stack under the cursor
    const target = grid.at(x + h.ox, y + h.oy) ?? grid.at(x, y);
    if (target && target !== h.stack && target.id === h.stack.id && d.stack > 1 && target.qty < d.stack) {
      const n = Math.min(h.stack.qty, d.stack - target.qty);
      target.qty += n;
      h.stack.qty -= n;
      grid.touch();
      if (h.stack.qty > 0) this.restore(h);
      return true;
    }
    if (!grid.canPlace(h.stack, x, y)) return false;
    grid.place(h.stack, x, y);
    return true;
  }

  private dropSlot(slot: SlotId): boolean {
    const h = this.held!;
    const inv = this.o.inv;
    if (!inv.accepts(slot, h.stack)) return false;
    const cur = inv.slots[slot];
    if (!cur) {
      inv.slots[slot] = h.stack;
      return true;
    }
    const d = itemDef(h.stack.id);
    if (cur.id === h.stack.id && d.stack > 1) {
      const n = Math.min(h.stack.qty, d.stack - cur.qty);
      cur.qty += n;
      h.stack.qty -= n;
      if (h.stack.qty > 0) this.restore(h);
      return true;
    }
    // Swap: the occupant goes back to where the held item came from
    inv.slots[slot] = h.stack;
    const o = h.origin;
    if (o.kind === 'grid') {
      if (!o.grid.place(cur, o.x, o.y) && o.grid.add(cur) > 0) this.o.onDiscard(cur, o);
    } else if (o.kind === 'slot' && inv.accepts(o.slot, cur)) {
      inv.slots[o.slot] = cur;
    } else if (inv.backpack.add(cur) > 0) this.o.onDiscard(cur, { kind: 'slot', slot });
    return true;
  }

  private gridPanels(): { p: GridPanelSpec; i: number }[] {
    return this.panels.map((p, i) => ({ p, i })).filter((e): e is { p: GridPanelSpec; i: number } => e.p.kind === 'grid');
  }

  /** Move a stack to the "other side" (backpack ↔ container/stash; equipment → backpack). */
  private quickMove(s: ItemStack, loc: Loc, preferEquip = false): void {
    const inv = this.o.inv;
    const d = itemDef(s.id);
    const grids = this.gridPanels();
    const backpack = grids.find((g) => g.p.role === 'backpack')?.p.grid;
    const other = grids.find((g) => g.p.role !== 'backpack')?.p.grid;
    this.removeFrom(s, loc);
    let ok = false;
    const fromOther = loc.kind === 'grid' && loc.grid !== backpack;
    // Equip first when coming from outside, or double-clicked
    if (loc.kind !== 'slot' && (fromOther || preferEquip)) {
      const slots: SlotId[] = d.cat === 'weapon' ? ['w0', 'w1'] : d.cat === 'shield' ? ['shield'] : [];
      if ((d.cat === 'med' || d.cat === 'throwable') && preferEquip) slots.push('q0', 'q1', 'q2', 'q3');
      for (const id of slots) if (!inv.slots[id]) {
        inv.slots[id] = s;
        ok = true;
        break;
      }
    }
    if (!ok) {
      const dest = loc.kind === 'slot' ? backpack ?? other : fromOther ? backpack : other;
      if (dest) {
        const left = dest.add(s);
        ok = left === 0;
        if (!ok) {
          // put back the remainder
          if (loc.kind === 'grid') loc.grid.add(s);
          else if (loc.kind === 'slot') inv.slots[loc.slot] = s;
        }
      } else if (loc.kind === 'grid') loc.grid.add(s);
      else if (loc.kind === 'slot') inv.slots[loc.slot] = s;
    }
    this.hovered = null;
    this.commit();
  }

  private discard(s: ItemStack, loc: Loc): void {
    this.removeFrom(s, loc);
    if (!this.o.onDiscard(s, loc)) this.restore({ stack: s, origin: loc, ox: 0, oy: 0 });
    this.hovered = null;
    this.commit();
  }

  private split(s: ItemStack, loc: Loc): ItemStack | null {
    if (s.qty < 2 || loc.kind === 'split') return null;
    const half = Math.floor(s.qty / 2);
    s.qty -= half;
    return { ...s, uid: newUid(), qty: half };
  }

  // ================================================================ mouse

  private bindMouse(): void {
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('keydown', this.onKey);
  }

  private onDown(e: PointerEvent, s: ItemStack, loc: Loc): void {
    if (e.button !== 0 || this.held) return;
    e.preventDefault();
    e.stopPropagation();
    this.cursor = null;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cell = this.cellPx();
    const ox = loc.kind === 'grid' ? Math.max(0, Math.floor((e.clientX - rect.left) / cell)) : 0;
    const oy = loc.kind === 'grid' ? Math.max(0, Math.floor((e.clientY - rect.top) / cell)) : 0;
    if (e.shiftKey) {
      const part = this.split(s, loc);
      if (part) this.held = { stack: part, origin: { kind: 'split', of: s }, ox: 0, oy: 0 };
      else return;
    } else {
      this.removeFrom(s, loc);
      this.held = { stack: s, origin: loc, ox, oy };
    }
    this.mouse = { x: e.clientX, y: e.clientY };
    this.showGhost();
    this.render();
  }

  private onMove = (e: PointerEvent): void => {
    this.mouse = { x: e.clientX, y: e.clientY };
    if (this.held && !this.cursor) this.positionGhost(e.clientX, e.clientY);
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.held || this.cursor || e.button !== 0) return;
    const h = this.held;
    let ok = false;
    const slotEl = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-slot]');
    if (slotEl && this.el.contains(slotEl)) ok = this.dropSlot(slotEl.dataset.slot as SlotId);
    else {
      const hit = this.gridAt(e.clientX, e.clientY);
      if (hit) ok = this.dropGrid(hit.grid, hit.x - h.ox, hit.y - h.oy);
    }
    if (!ok) this.restore(h);
    this.held = null;
    this.ghost.remove();
    this.commit();
  };

  private onKey = (e: KeyboardEvent): void => {
    if (this.disposed || !this.el.isConnected) return;
    if ((e.code === 'Delete' || e.code === 'Backspace') && this.hovered && !this.held) {
      e.preventDefault();
      this.discard(this.hovered.stack, this.hovered.loc);
    }
  };

  private cellPx(): number {
    // --cell is a clamp() expression, so measure a rendered grid instead
    const g = this.gridEls.values().next().value as HTMLElement | undefined;
    const v = g ? g.clientWidth / Number(g.style.getPropertyValue('--gw') || 1) : 48;
    return Number.isFinite(v) && v > 0 ? v : 48;
  }

  private gridAt(px: number, py: number): { grid: Grid; x: number; y: number; i: number } | null {
    const cell = this.cellPx();
    for (const [i, el] of this.gridEls) {
      const r = el.getBoundingClientRect();
      const scroller = el.parentElement!.getBoundingClientRect();
      if (px < Math.max(r.left, scroller.left) || px > Math.min(r.right, scroller.right) || py < Math.max(r.top, scroller.top) || py > Math.min(r.bottom, scroller.bottom)) continue;
      const p = this.panels[i] as GridPanelSpec;
      return { grid: p.grid, x: Math.floor((px - r.left) / cell), y: Math.floor((py - r.top) / cell), i };
    }
    return null;
  }

  private showGhost(): void {
    const h = this.held!;
    const d = itemDef(h.stack.id);
    const cell = this.cellPx();
    this.ghost.style.setProperty('--rc', rarityColor(stackRarity(h.stack)));
    this.ghost.style.width = `${d.w * cell}px`;
    this.ghost.style.height = `${d.h * cell}px`;
    this.ghost.innerHTML = `${iconSvg(d.icon)}${d.stack > 1 ? `<span class="it-qty">${h.stack.qty}</span>` : ''}`;
    document.body.appendChild(this.ghost);
    this.positionGhost(this.mouse.x, this.mouse.y);
  }

  private positionGhost(x: number, y: number): void {
    const h = this.held;
    if (!h) return;
    const cell = this.cellPx();
    this.ghost.style.transform = `translate(${x - (h.ox + 0.5) * cell}px, ${y - (h.oy + 0.5) * cell}px)`;
  }

  // ================================================================ gamepad

  /** Per frame while the board is visible. */
  pad(nav: PadNav): void {
    const dirs = (['up', 'down', 'left', 'right'] as const).filter((d) => nav.pressed(d));
    const any = dirs.length || nav.pressed('a') || nav.pressed('x') || nav.pressed('y') || nav.pressed('rb') || nav.pressed('b');
    if (!any) return;
    if (!this.cursor) {
      this.cursor = this.initialCursor();
      if (dirs.length || nav.pressed('a')) {
        this.drawCursor();
        this.updateDetails();
        return;
      }
    }
    for (const d of dirs) this.moveCursor(d);
    const c = this.cursor!;
    const under = this.cursorStack();
    if (nav.pressed('a')) {
      if (this.held) {
        const h = this.held;
        let ok = false;
        const p = this.panels[c.p];
        if (p.kind === 'equip') ok = this.dropSlot(EQUIP_ROWS[c.y][c.x]);
        else if (p.kind === 'grid') ok = this.dropGrid(p.grid, c.x, c.y);
        if (ok) {
          this.held = null;
          this.ghost.remove();
          this.commit();
        } else if (h) this.flashCursor();
      } else if (under) {
        this.removeFrom(under.stack, under.loc);
        this.held = { stack: under.stack, origin: under.loc, ox: 0, oy: 0 };
        if (under.loc.kind === 'grid') {
          c.x = under.stack.x;
          c.y = under.stack.y;
        }
        this.render();
      }
    } else if (nav.pressed('x') && under && !this.held) {
      this.quickMove(under.stack, under.loc);
    } else if (nav.pressed('y')) {
      if (this.held) {
        const h = this.held;
        this.held = null;
        this.ghost.remove();
        if (h.origin.kind === 'split') this.o.onDiscard(h.stack, h.origin);
        else if (!this.o.onDiscard(h.stack, h.origin)) this.restore(h);
        this.commit();
      } else if (under) this.discard(under.stack, under.loc);
    } else if (nav.pressed('rb') && under && !this.held) {
      const part = this.split(under.stack, under.loc);
      if (part) {
        this.held = { stack: part, origin: { kind: 'split', of: under.stack }, ox: 0, oy: 0 };
        this.render();
      }
    } else if (nav.pressed('b')) {
      if (this.held) this.cancelHeld();
      else this.o.onClose?.();
      return;
    }
    this.drawCursor();
    this.updateDetails();
  }

  get padCursorActive(): boolean {
    return this.cursor !== null;
  }

  private initialCursor(): Cursor {
    const bp = this.panels.findIndex((p) => p.kind === 'grid' && p.role === 'backpack');
    return { p: bp >= 0 ? bp : 0, x: 0, y: 0 };
  }

  private cursorStack(): { stack: ItemStack; loc: Loc } | null {
    const c = this.cursor;
    if (!c) return null;
    const p = this.panels[c.p];
    if (p?.kind === 'equip') {
      const id = EQUIP_ROWS[c.y]?.[c.x];
      const s = id ? this.o.inv.slots[id] : null;
      return s && id ? { stack: s, loc: { kind: 'slot', slot: id } } : null;
    }
    if (p?.kind === 'grid') {
      const s = p.grid.at(c.x, c.y);
      return s ? { stack: s, loc: { kind: 'grid', grid: p.grid, x: s.x, y: s.y } } : null;
    }
    return null;
  }

  private dims(i: number): { w: number; h: number } {
    const p = this.panels[i];
    if (p.kind === 'grid') return { w: p.grid.w, h: p.grid.h };
    if (p.kind === 'equip') return { w: 1, h: EQUIP_ROWS.length };
    return { w: 0, h: 0 };
  }

  private moveCursor(dir: 'up' | 'down' | 'left' | 'right'): void {
    const c = this.cursor!;
    const p = this.panels[c.p];
    if (p.kind === 'equip') {
      const row = EQUIP_ROWS[c.y];
      if (dir === 'up' && c.y > 0) {
        c.y--;
        c.x = Math.min(c.x, EQUIP_ROWS[c.y].length - 1);
      } else if (dir === 'down' && c.y < EQUIP_ROWS.length - 1) {
        c.y++;
        c.x = Math.min(c.x, EQUIP_ROWS[c.y].length - 1);
      } else if (dir === 'left' && c.x > 0) c.x--;
      else if (dir === 'right' && c.x < row.length - 1) c.x++;
      else if (dir === 'left' || dir === 'right') this.hopPanel(dir === 'left' ? -1 : 1);
      return;
    }
    const { w, h } = this.dims(c.p);
    // Skip across the cells of a multi-cell item
    const cur = p.kind === 'grid' ? p.grid.at(c.x, c.y) : undefined;
    const cd = cur ? itemDef(cur.id) : null;
    if (dir === 'left') {
      const nx = cur ? cur.x - 1 : c.x - 1;
      if (nx < 0) this.hopPanel(-1);
      else c.x = nx;
    } else if (dir === 'right') {
      const nx = cur && cd ? cur.x + cd.w : c.x + 1;
      if (nx >= w) this.hopPanel(1);
      else c.x = nx;
    } else if (dir === 'up') {
      const ny = cur ? cur.y - 1 : c.y - 1;
      if (ny >= 0) c.y = ny;
    } else {
      const ny = cur && cd ? cur.y + cd.h : c.y + 1;
      if (ny < h) c.y = ny;
    }
  }

  private hopPanel(step: number): void {
    const c = this.cursor!;
    const fromH = Math.max(1, this.dims(c.p).h);
    const ratio = c.y / fromH;
    for (let i = c.p + step; i >= 0 && i < this.panels.length; i += step) {
      const p = this.panels[i];
      if (p.kind === 'empty') continue;
      const { w, h } = this.dims(i);
      c.p = i;
      if (p.kind === 'equip') {
        c.y = Math.min(EQUIP_ROWS.length - 1, Math.floor(ratio * EQUIP_ROWS.length));
        c.x = step > 0 ? 0 : EQUIP_ROWS[c.y].length - 1;
      } else {
        c.y = Math.min(h - 1, Math.floor(ratio * h));
        c.x = step > 0 ? 0 : w - 1;
      }
      return;
    }
  }

  private flashCursor(): void {
    this.cursorEl.classList.remove('bad');
    void this.cursorEl.offsetWidth;
    this.cursorEl.classList.add('bad');
  }

  private drawCursor(): void {
    const c = this.cursor;
    if (!c) {
      this.cursorEl.style.display = 'none';
      if (this.held && !this.ghost.isConnected) this.showGhost();
      return;
    }
    const p = this.panels[c.p];
    let target: DOMRect | null = null;
    const board = this.el.getBoundingClientRect();
    if (p.kind === 'equip') {
      const id = EQUIP_ROWS[c.y][c.x];
      const el = this.el.querySelector<HTMLElement>(`[data-slot="${id}"]`);
      target = el?.getBoundingClientRect() ?? null;
      el?.scrollIntoView({ block: 'nearest' });
    } else if (p.kind === 'grid') {
      const g = this.gridEls.get(c.p);
      if (g) {
        const cell = this.cellPx();
        const under = this.held ? null : p.grid.at(c.x, c.y);
        const d = this.held ? itemDef(this.held.stack.id) : under ? itemDef(under.id) : { w: 1, h: 1 };
        const x = under ? under.x : c.x;
        const y = under ? under.y : c.y;
        // keep the cursor visible in scrolling panels
        const sc = g.parentElement!;
        const top = y * cell;
        if (top < sc.scrollTop) sc.scrollTop = top;
        else if (top + d.h * cell > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + d.h * cell - sc.clientHeight;
        target = new DOMRect(g.getBoundingClientRect().left + x * cell, g.getBoundingClientRect().top + y * cell, d.w * cell, d.h * cell);
        if (this.held) {
          const ok = p.grid.canPlace(this.held.stack, c.x, c.y) || p.grid.at(c.x, c.y)?.id === this.held.stack.id;
          this.cursorEl.classList.toggle('invalid', !ok);
        } else this.cursorEl.classList.remove('invalid');
      }
    }
    if (!target) {
      this.cursorEl.style.display = 'none';
      return;
    }
    this.cursorEl.style.display = 'block';
    this.cursorEl.style.left = `${target.left - board.left}px`;
    this.cursorEl.style.top = `${target.top - board.top}px`;
    this.cursorEl.style.width = `${target.width}px`;
    this.cursorEl.style.height = `${target.height}px`;
    // Held item rides on the cursor
    if (this.held) {
      if (!this.ghost.isConnected) this.showGhost();
      this.ghost.style.transform = `translate(${target.left + 6}px, ${target.top + 6}px)`;
    }
  }
}
