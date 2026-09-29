import * as THREE from 'three';
import type { RaidManager } from '../raid/RaidManager';
import type { LootContainer } from '../loot/Containers';
import { fmtTime } from './RaidHUD';
import { InvBoard, type PanelSpec } from './InvBoard';
import { PadNav } from './PadNav';
import { glyph } from './Glyphs';

/**
 * In-raid inventory: equipment + backpack, plus the loot panel of the container
 * being searched. The world keeps running while it is open.
 */
export class InventoryUI {
  open = false;
  container: LootContainer | null = null;
  private root: HTMLElement;
  private board: InvBoard;
  private head: HTMLElement;
  private nav = new PadNav();

  constructor(private raid: RaidManager) {
    this.root = document.createElement('div');
    this.root.className = 'w3-inv';
    this.root.innerHTML = `<div class="w3-inv-frame"><div class="w3-inv-head"><h2>INVENTORY</h2><div class="w3-inv-info"></div></div><div class="w3-inv-body"></div></div>`;
    this.head = this.root.querySelector('.w3-inv-info')!;
    this.board = new InvBoard({
      inv: raid.inv,
      panels: this.panels(),
      discardLabel: 'Drop',
      onDiscard: (stack) => {
        const g = this.raid.game;
        const fwd = new THREE.Vector3(-Math.sin(g.rig.yaw), 0, -Math.cos(g.rig.yaw));
        const p = g.player.feet().addScaledVector(fwd, 0.9);
        this.raid.containers.drop(p, [stack]);
        return true;
      },
      onChange: () => this.container?.refreshLight(),
      onClose: () => this.raid.closeInventory(),
    });
    this.root.querySelector('.w3-inv-body')!.appendChild(this.board.el);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (this.open && e.code === 'Escape') this.raid.closeInventory();
    });
  }

  private panels(): PanelSpec[] {
    const c = this.container;
    return [
      { kind: 'equip' },
      { kind: 'grid', grid: this.raid.inv.backpack, title: 'Backpack', role: 'backpack' },
      c
        ? { kind: 'grid', grid: c.grid, title: c.name, role: 'container', subtitle: c.grid.items.length ? `${c.grid.value().toLocaleString()} cr` : 'empty' }
        : { kind: 'empty', title: 'Nearby', text: 'Search a container or body to loot it here.' },
    ];
  }

  show(container: LootContainer | null): void {
    this.container = container;
    this.board.setPanels(this.panels());
    if (!this.root.isConnected) document.body.appendChild(this.root);
    this.open = true;
    document.body.classList.add('w3-inv-open');
    this.nav.poll(0);
    this.nav.consume();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.board.setPanels(this.panels()); // returns any held item
    this.container?.refreshLight();
    this.container = null;
    this.root.remove();
    document.body.classList.remove('w3-inv-open');
  }

  update(dt: number): void {
    if (!this.open) return;
    // Close if the looted container is gone or we were moved away
    const c = this.container;
    if (c) {
      const f = this.raid.game.player.feet();
      if (Math.hypot(c.pos.x - f.x, c.pos.z - f.z) > 4) {
        this.container = null;
        this.board.setPanels(this.panels());
      }
    }
    this.nav.poll(dt);
    if (this.nav.pressed('menu')) {
      this.raid.closeInventory();
      return;
    }
    this.board.pad(this.nav);
    this.board.refresh();
    const input = this.raid.game.input;
    const inv = glyph('inventory', input.activeDevice, input.padStyle);
    this.head.innerHTML = `<span>Raid <b>${fmtTime(this.raid.timeLeft)}</b></span><span>Carried <b>${this.raid.inv.value().toLocaleString()} cr</b></span><span class="w3-close"><kbd>${input.activeDevice === 'gamepad' ? 'B' : inv}</kbd>Close</span>`;
  }
}
