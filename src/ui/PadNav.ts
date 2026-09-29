/**
 * Gamepad polling for menus / inventory (standard mapping). Edge-detected
 * buttons plus D-pad / left-stick directions with key-repeat.
 */

export type PadButton = 'a' | 'b' | 'x' | 'y' | 'lb' | 'rb' | 'view' | 'menu' | 'up' | 'down' | 'left' | 'right';

const IDX: Record<PadButton, number> = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, view: 8, menu: 9, up: 12, down: 13, left: 14, right: 15 };
const DIRS: PadButton[] = ['up', 'down', 'left', 'right'];
const REPEAT_DELAY = 0.32;
const REPEAT_RATE = 0.09;

export class PadNav {
  private prev = new Set<PadButton>();
  private now = new Set<PadButton>();
  private edges = new Set<PadButton>();
  private held: Record<string, number> = {};
  /** True if a pad produced input this frame. */
  active = false;

  poll(dt: number): void {
    this.edges.clear();
    this.prev = this.now;
    this.now = new Set();
    this.active = false;
    const pads = navigator.getGamepads?.() ?? [];
    let pad: Gamepad | null = null;
    for (const p of pads) if (p && p.connected) {
      pad = p;
      break;
    }
    if (!pad) return;
    for (const [name, i] of Object.entries(IDX) as [PadButton, number][]) if (pad.buttons[i]?.pressed) this.now.add(name);
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    if (ax < -0.6) this.now.add('left');
    if (ax > 0.6) this.now.add('right');
    if (ay < -0.6) this.now.add('up');
    if (ay > 0.6) this.now.add('down');
    for (const b of this.now) {
      if (!this.prev.has(b)) {
        this.edges.add(b);
        this.held[b] = 0;
      } else if (DIRS.includes(b)) {
        const t = (this.held[b] ?? 0) + dt;
        // repeat after a delay
        if (t > REPEAT_DELAY) {
          this.edges.add(b);
          this.held[b] = REPEAT_DELAY - REPEAT_RATE;
        } else this.held[b] = t;
      }
    }
    this.active = this.now.size > 0;
  }

  pressed(b: PadButton): boolean {
    return this.edges.has(b);
  }

  down(b: PadButton): boolean {
    return this.now.has(b);
  }

  /** Swallow current buttons so they don't trigger again on the next screen. */
  consume(): void {
    this.edges.clear();
  }
}

/** Spatial focus movement among focusable elements inside root (menus). */
export function moveFocus(root: HTMLElement, dir: 'up' | 'down' | 'left' | 'right'): void {
  const els = [...root.querySelectorAll<HTMLElement>('[data-nav]:not([disabled])')].filter((e) => e.offsetParent !== null);
  if (!els.length) return;
  const cur = document.activeElement as HTMLElement | null;
  if (!cur || !els.includes(cur)) {
    els[0].focus();
    return;
  }
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestD = Infinity;
  for (const e of els) {
    if (e === cur) continue;
    const r = e.getBoundingClientRect();
    const dx = r.left + r.width / 2 - ax;
    const dy = r.top + r.height / 2 - ay;
    const along = dir === 'up' ? -dy : dir === 'down' ? dy : dir === 'left' ? -dx : dx;
    const across = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
    if (along <= 4) continue;
    const d = along + across * 2.2;
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  best?.focus();
  best?.scrollIntoView({ block: 'nearest' });
}
