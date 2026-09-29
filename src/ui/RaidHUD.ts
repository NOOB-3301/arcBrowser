import type { RaidManager } from '../raid/RaidManager';
import { QUICK_SLOTS } from '../loot/Inventory';
import { itemDef, rarityColor, stackRarity } from '../loot/Items';
import { iconSvg } from '../loot/Icons';
import { glyph } from './Glyphs';

const STATUS_LABEL = { open: 'OPEN', closed: 'CLOSED', locked: 'KEY', power: 'NO POWER' } as const;

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

/** Raid HUD: timer, extracts with distance, carried value, interaction prompt, extraction countdown, quick slots. */
export class RaidHUD {
  private root: HTMLElement;
  private timer: HTMLElement;
  private exList: HTMLElement;
  private carried: HTMLElement;
  private prompt: HTMLElement;
  private promptFill: SVGCircleElement;
  private extract: HTMLElement;
  private quick: HTMLElement;
  private t = 0;
  private lastQuick = '';

  constructor(private raid: RaidManager) {
    this.root = document.createElement('div');
    this.root.className = 'rhud';
    this.root.innerHTML = `
      <div class="rhud-panel">
        <div class="rhud-timer"><span class="rhud-clock"></span><small>IRONVALE BASIN</small></div>
        <div class="rhud-carried"></div>
        <div class="rhud-ex"></div>
      </div>
      <div class="rhud-prompt">
        <svg viewBox="0 0 40 40"><circle class="bg" cx="20" cy="20" r="16"/><circle class="fg" cx="20" cy="20" r="16"/></svg>
        <kbd></kbd><span class="rhud-verb"></span><b class="rhud-name"></b>
      </div>
      <div class="rhud-extract"><div class="rhud-extract-title">EXTRACTING</div><div class="rhud-extract-num"></div><div class="rhud-extract-bar"><i></i></div><small>Stay in the zone · machines are coming</small></div>
      <div class="rhud-quick"></div>`;
    document.getElementById('ui')!.appendChild(this.root);
    const q = <T extends Element = HTMLElement>(s: string) => this.root.querySelector(s) as unknown as T;
    this.timer = q('.rhud-clock');
    this.exList = q('.rhud-ex');
    this.carried = q('.rhud-carried');
    this.prompt = q('.rhud-prompt');
    this.promptFill = q<SVGCircleElement>('.rhud-prompt .fg');
    this.extract = q('.rhud-extract');
    this.quick = q('.rhud-quick');
    this.setVisible(false);
  }

  setVisible(on: boolean): void {
    this.root.style.display = on ? 'block' : 'none';
  }

  update(dt: number): void {
    const raid = this.raid;
    const g = raid.game;
    this.t -= dt;
    const input = g.input;
    const dev = input.activeDevice;

    // Timer (flash under 5 minutes)
    this.timer.textContent = fmtTime(raid.timeLeft);
    this.timer.parentElement!.classList.toggle('low', raid.timeLeft < 300);

    if (this.t <= 0) {
      this.t = 0.2;
      const feet = g.player.feet();
      const rows = raid.extraction.states.map((s) => {
        const d = Math.hypot(s.point.pos.x - feet.x, s.point.pos.z - feet.z);
        let status: string = STATUS_LABEL[s.status];
        if (s.status === 'closed' && s.opensAt !== null) status = `OPENS ${fmtTime(Math.max(0, raid.timeLeft - (s.opensAt - raid.elapsed)))}`;
        if (s.status !== 'open' && s.key && raid.inv.has(s.key)) status = 'KEY READY';
        return { s, d, status };
      });
      rows.sort((a, b) => (a.s.status === 'open' ? 0 : 1) - (b.s.status === 'open' ? 0 : 1) || a.d - b.d);
      this.exList.innerHTML = rows
        .map((r) => `<div class="rhud-exrow st-${r.s.status}"><i></i><span>${r.s.point.def.name}</span><em>${r.status}</em><b>${Math.round(r.d)} m</b></div>`)
        .join('');
      this.carried.innerHTML = `<span>Carried</span><b>${raid.inv.value().toLocaleString()} cr</b><span class="rhud-kg">${raid.inv.weight().toFixed(1)} kg</span>`;
    }

    // Interaction prompt
    const t = raid.target;
    if (t && !raid.blocksInput) {
      const isC = 'grid' in t;
      const searched = isC && t.searched;
      const locked = isC && t.lockedBy && !t.searched;
      const k = glyph('interact', dev, input.padStyle);
      const key = searched ? k.replace(/^Hold /, '') : dev === 'gamepad' ? k : `Hold ${k}`;
      this.prompt.querySelector('kbd')!.textContent = key;
      this.prompt.querySelector('.rhud-verb')!.textContent = isC ? (searched ? 'Open' : locked ? 'Unlock' : 'Search') : t.verb;
      this.prompt.querySelector('.rhud-name')!.textContent = isC ? `${t.name}${searched && t.grid.items.length === 0 ? ' · empty' : ''}` : t.label;
      const p = raid.searchProgress;
      this.promptFill.style.strokeDashoffset = `${(1 - Math.max(0, p)) * 100.5}`;
      this.prompt.classList.toggle('busy', p >= 0);
      this.prompt.classList.add('show');
    } else this.prompt.classList.remove('show');

    // Extraction countdown
    const ex = raid.extraction;
    if (ex.active) {
      this.extract.classList.add('show');
      this.extract.querySelector('.rhud-extract-num')!.textContent = Math.max(0, ex.holdTime - ex.progress).toFixed(1);
      (this.extract.querySelector('.rhud-extract-bar i') as HTMLElement).style.width = `${Math.min(100, (ex.progress / ex.holdTime) * 100)}%`;
    } else this.extract.classList.remove('show');

    // Quick slots
    const sel = raid.selectedThrowSlot;
    const sig = QUICK_SLOTS.map((q) => `${raid.inv.slots[q]?.id ?? '-'}:${raid.inv.slots[q]?.qty ?? 0}`).join(',') + sel + dev;
    if (sig !== this.lastQuick) {
      this.lastQuick = sig;
      const heal = glyph('heal', dev, input.padStyle);
      const thr = glyph('throwable', dev, input.padStyle);
      this.quick.innerHTML = QUICK_SLOTS.map((q) => {
        const s = raid.inv.slots[q];
        if (!s) return `<div class="rhud-q empty"></div>`;
        const d = itemDef(s.id);
        const bind = d.cat === 'med' ? heal : q === sel ? thr : '';
        return `<div class="rhud-q ${q === sel ? 'sel' : ''}" style="--rc:${rarityColor(stackRarity(s))}">${iconSvg(d.icon)}<span>${s.qty}</span>${bind ? `<kbd>${bind}</kbd>` : ''}</div>`;
      }).join('');
    }
  }
}
