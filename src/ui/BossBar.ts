import type * as THREE from 'three';
import { Events } from '../core/Events';
import type { Bot } from '../ai/Bot';
import type { Input } from '../core/Input';
import { THROWABLE_DEFS, type Throwables } from '../weapons/Throwables';

const SHOW_DIST = 120;

interface BossLike extends Bot {
  displayName: string;
  plateHp: number[];
  plateMax: number;
  engagedT: number;
  coreExposed: boolean;
}

/** W4: boss health bar (top centre) shown near / while fighting a Colossus. */
export class BossBar {
  private root: HTMLElement;
  private fill: HTMLElement;
  private lag: HTMLElement;
  private name: HTMLElement;
  private pips: HTMLElement;
  private lagW = 1;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'boss-bar';
    this.root.innerHTML = `<div class="boss-name"></div><div class="boss-track"><div class="boss-lag"></div><div class="boss-fill"></div></div><div class="boss-pips"></div>`;
    document.getElementById('ui')!.appendChild(this.root);
    this.fill = this.root.querySelector('.boss-fill')!;
    this.lag = this.root.querySelector('.boss-lag')!;
    this.name = this.root.querySelector('.boss-name')!;
    this.pips = this.root.querySelector('.boss-pips')!;
  }

  update(dt: number, bots: readonly Bot[], player: THREE.Vector3): void {
    let boss: BossLike | null = null;
    let best = Infinity;
    for (const b of bots) {
      if (b.kind !== 'colossus' || !b.health.alive) continue;
      const bl = b as BossLike;
      const d = b.pos.distanceTo(player);
      if ((d < SHOW_DIST || bl.engagedT < 8) && d < best) {
        best = d;
        boss = bl;
      }
    }
    this.root.classList.toggle('show', !!boss);
    if (!boss) return;
    const k = boss.health.hp / boss.health.maxHp;
    this.lagW = Math.max(k, this.lagW - dt * 0.25);
    if (this.lagW < k) this.lagW = k;
    this.fill.style.width = `${(k * 100).toFixed(1)}%`;
    this.lag.style.width = `${(this.lagW * 100).toFixed(1)}%`;
    this.name.textContent = boss.coreExposed ? `${boss.displayName} — CORE EXPOSED` : boss.displayName;
    this.root.classList.toggle('exposed', boss.coreExposed);
    const html = boss.plateHp.map((h) => `<i style="--k:${Math.max(0, h / boss!.plateMax).toFixed(2)}"></i>`).join('');
    if (this.pips.innerHTML !== html) this.pips.innerHTML = html;
  }
}

/** W4: small widget (bottom right, above the weapon panel) for the selected throwable. */
export class ThrowableWidget {
  private root: HTMLElement;
  private flashT = 0;

  constructor(private throwables: Throwables, private input: Input) {
    this.root = document.createElement('div');
    this.root.className = 'throwable-widget';
    document.getElementById('ui')!.appendChild(this.root);
    Events.on('throwable:changed', () => (this.flashT = 0.4));
  }

  update(dt: number): void {
    this.flashT = Math.max(0, this.flashT - dt);
    const t = this.throwables;
    const def = THROWABLE_DEFS[t.selected];
    const key = this.input.activeDevice === 'gamepad' ? 'LB' : 'G';
    const html = `<span class="tw-icon" style="background:${def.color}">${def.short}</span><span class="tw-name">${def.name}</span><b class="tw-count">×${t.count}</b><small>${key} tap: cycle · hold: throw</small>`;
    if (this.root.innerHTML !== html) this.root.innerHTML = html;
    this.root.classList.toggle('flash', this.flashT > 0);
    this.root.classList.toggle('empty', t.count === 0);
  }
}
