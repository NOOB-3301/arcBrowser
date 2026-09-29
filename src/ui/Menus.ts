import type { RaidManager, RaidOutcome } from '../raid/RaidManager';
import { Settings } from '../core/Settings';
import { Events } from '../core/Events';
import { DIFFICULTIES, type DifficultyId } from '../ai/Difficulty';
import type { TimeOfDay } from '../world/DayNight';
import { SLOT_IDS } from '../loot/Inventory';
import { itemDef, rarityColor, stackRarity, type ItemStack } from '../loot/Items';
import { iconSvg } from '../loot/Icons';
import { OFFERS, RECIPES, sellPrice } from '../loot/Stash';
import { InvBoard } from './InvBoard';
import { PadNav, moveFocus } from './PadNav';
import { fmtTime } from './RaidHUD';
import { Sfx } from '../audio/Sfx';

export interface RaidResult {
  outcome: RaidOutcome;
  time: number;
  kills: number;
  carried: number;
  banked: number;
  lost: number;
  gained: number;
  difficulty: DifficultyId;
}

type Screen = 'main' | 'stash' | 'deploy' | 'settings' | 'credits' | 'pause' | 'results';
type StashTab = 'loadout' | 'trader' | 'workshop';

const TIMES: { id: TimeOfDay; label: string }[] = [
  { id: 'morning', label: 'Morning' },
  { id: 'noon', label: 'Noon' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'overcast', label: 'Overcast' },
];

const MAPS = [
  { id: 'ironvale', name: 'Ironvale Basin', desc: 'Flooded valley under a failing dam. Village, town, container yard.', locked: false },
  { id: 'rustmoor', name: 'Rustmoor Flats', desc: 'Salt pans and a derelict refinery.', locked: true },
  { id: 'ashfall', name: 'Ashfall Quarry', desc: 'Terraced pits patrolled by heavy ARC.', locked: true },
];

const ICON = (i: string) => iconSvg(itemDef(i).icon);

/** All out-of-raid screens + pause and results. Plain DOM, mouse + gamepad. */
export class Menus {
  private root: HTMLElement;
  private screen: Screen | null = null;
  private tab: StashTab = 'loadout';
  private board: InvBoard | null = null;
  private nav = new PadNav();
  private deployOpts: { difficulty: DifficultyId; time: TimeOfDay };
  private result: RaidResult | null = null;

  constructor(private raid: RaidManager) {
    this.root = document.createElement('div');
    this.root.className = 'w3-menus';
    document.body.appendChild(this.root);
    this.deployOpts = { difficulty: Settings.get('difficulty'), time: 'noon' };
    this.root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (el && !el.hasAttribute('disabled')) this.act(el.dataset.act!, el.dataset.arg);
    });
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (!this.screen || e.code !== 'Escape') return;
      if (this.screen === 'pause') this.act('resume');
      else if (this.screen !== 'main' && this.screen !== 'results') this.act('back');
    });
    Events.on('profile:changed', () => {
      if (this.screen === 'stash' && this.tab !== 'loadout') this.render();
      else this.updateCredits();
    });
  }

  get visible(): boolean {
    return this.screen !== null;
  }

  hide(): void {
    this.screen = null;
    this.disposeBoard();
    this.root.innerHTML = '';
    this.root.className = 'w3-menus';
  }

  showMain(): void {
    this.go('main');
  }

  showPause(): void {
    this.go('pause');
  }

  showResults(r: RaidResult): void {
    this.result = r;
    this.go('results');
    Sfx.unlock();
  }

  private go(s: Screen): void {
    this.screen = s;
    this.render();
    // focus the first action for pad users
    requestAnimationFrame(() => this.root.querySelector<HTMLElement>('[data-nav].primary, [data-nav]')?.focus({ preventScroll: true }));
  }

  // ================================================================ actions

  private act(a: string, arg?: string): void {
    const p = this.raid.profile;
    switch (a) {
      case 'deploy-screen':
        return this.go('deploy');
      case 'stash':
        this.tab = (arg as StashTab) ?? 'loadout';
        return this.go('stash');
      case 'tab':
        this.tab = arg as StashTab;
        this.render();
        return;
      case 'settings':
        return this.go('settings');
      case 'credits':
        return this.go('credits');
      case 'back':
        return this.go(this.raid.phase === 'raid' ? 'pause' : 'main');
      case 'diff':
        this.deployOpts.difficulty = arg as DifficultyId;
        this.render();
        return;
      case 'tod':
        this.deployOpts.time = arg as TimeOfDay;
        this.render();
        return;
      case 'deploy':
        Sfx.unlock();
        this.raid.deploy({ ...this.deployOpts });
        return;
      case 'resume':
        this.raid.setPaused(false);
        return;
      case 'abandon':
        this.raid.setPaused(false);
        this.raid.endRaid('mia');
        return;
      case 'continue':
        this.raid.toMenu();
        return;
      case 'buy': {
        const o = OFFERS.find((x) => x.id === arg)!;
        if (p.buy(o)) Events.emit('toast', `Bought ${o.name}`);
        this.render();
        return;
      }
      case 'craft': {
        const r = RECIPES.find((x) => x.id === arg)!;
        if (p.craft(r)) Events.emit('toast', `Crafted ${itemDef(r.out.id).name} ×${r.out.qty}`);
        this.render();
        return;
      }
      case 'sell': {
        const s = p.stash.items.find((x) => String(x.uid) === arg);
        if (s) p.sell(s);
        this.render();
        return;
      }
      case 'sell-valuables': {
        let total = 0;
        for (const s of [...p.stash.items]) if (itemDef(s.id).cat === 'valuable') total += p.sell(s);
        if (total) Events.emit('toast', `Sold valuables for ${total.toLocaleString()} cr`);
        this.render();
        return;
      }
      case 'set': {
        const [key, val] = (arg ?? '').split(':');
        if (key === 'invertY' || key === 'showDebug' || key === 'rumble') Settings.set(key, val === '1');
        this.render();
        return;
      }
    }
  }

  // ================================================================ render

  private disposeBoard(): void {
    this.board?.dispose();
    this.board = null;
  }

  private updateCredits(): void {
    const el = this.root.querySelector('.m-credits b');
    if (el) el.textContent = this.raid.profile.credits.toLocaleString();
  }

  private render(): void {
    this.disposeBoard();
    const s = this.screen;
    this.root.className = `w3-menus show scr-${s}`;
    if (!s) return;
    const p = this.raid.profile;
    const credits = `<div class="m-credits"><span>Credits</span><b>${p.credits.toLocaleString()}</b></div>`;
    switch (s) {
      case 'main': {
        const st = p.stats;
        const lv = p.loadout;
        const weapons = (['w0', 'w1'] as const).map((id) => lv.slots[id]).filter(Boolean) as ItemStack[];
        this.root.innerHTML = `
          <div class="m-main">
            <div class="m-brand"><h1>RUSTFALL</h1><p>Solo extraction · Ironvale Basin</p></div>
            <nav class="m-nav">
              <button data-nav data-act="deploy-screen" class="primary"><span>Deploy</span><small>Enter the raid</small></button>
              <button data-nav data-act="stash"><span>Stash &amp; Loadout</span><small>Gear up · what you bring is at risk</small></button>
              <button data-nav data-act="stash" data-arg="trader"><span>Trader</span><small>Sell valuables · buy kits</small></button>
              <button data-nav data-act="stash" data-arg="workshop"><span>Workshop</span><small>Craft ammo &amp; meds</small></button>
              <button data-nav data-act="settings"><span>Settings</span></button>
              <button data-nav data-act="credits"><span>Credits</span></button>
            </nav>
            <aside class="m-side">
              ${credits}
              <div class="m-card">
                <h4>Current loadout</h4>
                ${weapons.length ? weapons.map((w) => this.itemLine(w)).join('') : '<p class="m-dim">No weapons equipped</p>'}
                <div class="m-kv"><span>Value at risk</span><b>${lv.value().toLocaleString()} cr</b></div>
              </div>
              <div class="m-card m-stats">
                <div><b>${st.raids}</b><span>Raids</span></div>
                <div><b>${st.extracted}</b><span>Extracted</span></div>
                <div><b>${st.died + st.mia}</b><span>Lost</span></div>
                <div><b>${st.kills}</b><span>Kills</span></div>
              </div>
            </aside>
          </div>`;
        break;
      }
      case 'stash':
        this.renderStash(credits);
        break;
      case 'deploy':
        this.renderDeploy(credits);
        break;
      case 'settings': {
        const b = (k: 'invertY' | 'showDebug' | 'rumble', label: string) =>
          `<button data-nav class="m-toggle ${Settings.get(k) ? 'on' : ''}" data-act="set" data-arg="${k}:${Settings.get(k) ? 0 : 1}"><span>${label}</span><b>${Settings.get(k) ? 'ON' : 'OFF'}</b></button>`;
        this.root.innerHTML = `
          <div class="m-page m-narrow">
            <header class="m-head"><h2>Settings</h2><button data-nav data-act="back" class="m-back">Back</button></header>
            <div class="m-card">
              ${b('invertY', 'Invert look Y')}${b('rumble', 'Controller rumble')}${b('showDebug', 'Debug overlay')}
              <p class="m-dim">Sensitivity, FOV and more live in the Debug panel (top right). F9 cycles input device.</p>
            </div>
          </div>`;
        break;
      }
      case 'credits':
        this.root.innerHTML = `
          <div class="m-page m-narrow">
            <header class="m-head"><h2>Credits</h2><button data-nav data-act="back" class="m-back">Back</button></header>
            <div class="m-card m-prose">
              <p><b>RUSTFALL</b> — a browser extraction shooter prototype.</p>
              <p>Built with three.js, Rapier and Vite. Textures from Poly Haven (CC0).</p>
              <p class="m-dim">Loot, raid loop and menus: milestone M6.</p>
            </div>
          </div>`;
        break;
      case 'pause':
        this.root.innerHTML = `
          <div class="m-page m-narrow m-pause">
            <header class="m-head"><h2>Paused</h2><span class="m-dim">Raid time ${fmtTime(this.raid.timeLeft)}</span></header>
            <nav class="m-nav">
              <button data-nav data-act="resume" class="primary"><span>Resume</span></button>
              <button data-nav data-act="settings"><span>Settings</span></button>
              <button data-nav data-act="abandon" class="danger"><span>Abandon raid</span><small>Counts as MIA · loadout lost</small></button>
            </nav>
          </div>`;
        break;
      case 'results':
        this.renderResults();
        break;
    }
  }

  private itemLine(s: ItemStack): string {
    const d = itemDef(s.id);
    const r = stackRarity(s);
    return `<div class="m-item" style="--rc:${rarityColor(r)}">${iconSvg(d.icon)}<span>${d.name}</span><em>${r}</em></div>`;
  }

  private renderStash(credits: string): void {
    const p = this.raid.profile;
    const tabs = (['loadout', 'trader', 'workshop'] as StashTab[])
      .map((t) => `<button data-nav data-act="tab" data-arg="${t}" class="m-tab ${this.tab === t ? 'on' : ''}">${t === 'loadout' ? 'Stash &amp; Loadout' : t === 'trader' ? 'Trader' : 'Workshop'}</button>`)
      .join('');
    this.root.innerHTML = `
      <div class="m-page m-wide">
        <header class="m-head"><h2>Stash</h2><nav class="m-tabs">${tabs}</nav>${credits}<button data-nav data-act="back" class="m-back">Back</button></header>
        <div class="m-body"></div>
      </div>`;
    const body = this.root.querySelector<HTMLElement>('.m-body')!;
    if (this.tab === 'loadout') {
      this.board = new InvBoard({
        inv: p.loadout,
        panels: [
          { kind: 'grid', grid: p.stash, title: 'Stash', role: 'stash', scroll: true },
          { kind: 'equip' },
          { kind: 'grid', grid: p.loadout.backpack, title: 'Raid Backpack', role: 'backpack', subtitle: 'at risk' },
        ],
        discardLabel: 'Sell',
        onDiscard: (s) => {
          const price = sellPrice(s);
          p.credits += price;
          Events.emit('toast', `Sold ${itemDef(s.id).name} for ${price.toLocaleString()} cr`);
          return true;
        },
        onChange: () => p.save(),
        onClose: () => this.act('back'),
      });
      body.appendChild(this.board.el);
      return;
    }
    if (this.tab === 'trader') {
      const valuables = p.stash.items.filter((s) => itemDef(s.id).cat === 'valuable');
      const sellable = p.stash.items.filter((s) => itemDef(s.id).cat !== 'valuable').slice(0, 30);
      const row = (s: ItemStack) => {
        const d = itemDef(s.id);
        return `<div class="m-row" style="--rc:${rarityColor(stackRarity(s))}">${iconSvg(d.icon)}<span>${d.name}${d.stack > 1 ? ` ×${s.qty}` : ''}</span><b>${sellPrice(s).toLocaleString()} cr</b><button data-nav data-act="sell" data-arg="${s.uid}">Sell</button></div>`;
      };
      body.innerHTML = `
        <div class="m-cols">
          <section class="m-card m-scroll">
            <h4>Buy</h4>
            ${OFFERS.map((o) => {
              const first = o.items()[0];
              return `<div class="m-row m-offer" style="--rc:${rarityColor(stackRarity(first))}">${ICON(first.id)}<span><b>${o.name}</b><small>${o.desc}</small></span><b>${o.price.toLocaleString()} cr</b><button data-nav data-act="buy" data-arg="${o.id}" ${p.credits < o.price ? 'disabled' : ''}>Buy</button></div>`;
            }).join('')}
          </section>
          <section class="m-card m-scroll">
            <h4>Sell valuables <button data-nav data-act="sell-valuables" class="m-mini" ${valuables.length ? '' : 'disabled'}>Sell all</button></h4>
            ${valuables.length ? valuables.map(row).join('') : '<p class="m-dim">No valuables in your stash. Loot watches, drives, ARC parts…</p>'}
            <h4>Sell other</h4>
            ${sellable.map(row).join('') || '<p class="m-dim">Stash is empty.</p>'}
          </section>
        </div>`;
      return;
    }
    // workshop
    body.innerHTML = `
      <div class="m-cols">
        <section class="m-card m-scroll">
          <h4>Recipes <small class="m-dim">materials are taken from your stash</small></h4>
          ${RECIPES.map((r) => {
            const out = itemDef(r.out.id);
            const cost = r.cost
              .map((c) => {
                const have = p.stock(c.id);
                return `<span class="m-cost ${have >= c.qty ? '' : 'short'}">${ICON(c.id)}${itemDef(c.id).name} <b>${have}/${c.qty}</b></span>`;
              })
              .join('');
            return `<div class="m-row m-recipe" style="--rc:${rarityColor(out.rarity)}">${iconSvg(out.icon)}<span><b>${out.name} ×${r.out.qty}</b><small>${cost}</small></span><button data-nav data-act="craft" data-arg="${r.id}" ${p.canCraft(r) ? '' : 'disabled'}>Craft</button></div>`;
          }).join('')}
        </section>
        <section class="m-card m-scroll">
          <h4>Materials in stash</h4>
          ${['scrap', 'fabric', 'chemicals', 'circuitry', 'battery', 'rare_alloy', 'arc_servo']
            .map((id) => `<div class="m-row" style="--rc:${rarityColor(itemDef(id).rarity)}">${ICON(id)}<span>${itemDef(id).name}</span><b>${p.stock(id)}</b></div>`)
            .join('')}
        </section>
      </div>`;
  }

  private renderDeploy(credits: string): void {
    const p = this.raid.profile;
    const lv = p.loadout;
    const o = this.deployOpts;
    const equipped = SLOT_IDS.map((id) => lv.slots[id]).filter(Boolean) as ItemStack[];
    const hasWeapon = !!(lv.slots.w0 || lv.slots.w1);
    this.root.innerHTML = `
      <div class="m-page m-wide">
        <header class="m-head"><h2>Deploy</h2>${credits}<button data-nav data-act="back" class="m-back">Back</button></header>
        <div class="m-deploy">
          <section class="m-maps">
            ${MAPS.map((m) => `<div class="m-map ${m.locked ? 'locked' : 'on'}"><div class="m-map-art m-art-${m.id}"></div><div><b>${m.name}</b><small>${m.locked ? 'LOCKED · coming soon' : m.desc}</small></div></div>`).join('')}
          </section>
          <section class="m-card m-opts">
            <h4>Threat level</h4>
            <div class="m-seg">${Object.values(DIFFICULTIES).map((d) => `<button data-nav data-act="diff" data-arg="${d.id}" class="${o.difficulty === d.id ? 'on' : ''}">${d.label}</button>`).join('')}</div>
            <h4>Time of day</h4>
            <div class="m-seg">${TIMES.map((t) => `<button data-nav data-act="tod" data-arg="${t.id}" class="${o.time === t.id ? 'on' : ''}">${t.label}</button>`).join('')}</div>
            <h4>Raid</h4>
            <div class="m-kv"><span>Duration</span><b>30:00</b></div>
            <div class="m-kv"><span>Extracts</span><b>2–3 open · more open later</b></div>
          </section>
          <section class="m-card m-risk">
            <h4>Loadout at risk</h4>
            <div class="m-risk-list">${equipped.map((s) => this.itemLine(s)).join('') || '<p class="m-dim">Nothing equipped.</p>'}</div>
            <div class="m-kv"><span>Backpack</span><b>${lv.backpack.items.length} stacks</b></div>
            <div class="m-kv big"><span>Total value</span><b>${lv.value().toLocaleString()} cr</b></div>
            ${hasWeapon ? '' : '<p class="m-warn">No weapon equipped — you will deploy unarmed.</p>'}
            <button data-nav data-act="stash" class="m-link">Edit loadout</button>
            <button data-nav data-act="deploy" class="m-go primary">Deploy to Ironvale</button>
          </section>
        </div>
      </div>`;
  }

  private renderResults(): void {
    const r = this.result!;
    const title = r.outcome === 'extracted' ? 'EXTRACTED' : r.outcome === 'died' ? 'KILLED IN ACTION' : 'MISSING IN ACTION';
    const sub =
      r.outcome === 'extracted'
        ? 'Backpack contents moved to your stash. Equipped gear stays in your loadout.'
        : r.outcome === 'died'
          ? 'Your loadout and everything you carried is lost.'
          : 'The raid timer ran out. Your loadout and everything you carried is lost.';
    this.root.innerHTML = `
      <div class="m-results out-${r.outcome}">
        <div class="m-res-title"><small>Raid complete · ${DIFFICULTIES[r.difficulty].label}</small><h1>${title}</h1><p>${sub}</p></div>
        <div class="m-res-grid">
          <div><span>Time in raid</span><b>${fmtTime(r.time)}</b></div>
          <div><span>Kills</span><b>${r.kills}</b></div>
          <div><span>${r.outcome === 'extracted' ? 'Loot banked' : 'Value lost'}</span><b class="${r.outcome === 'extracted' ? 'good' : 'bad'}">${(r.outcome === 'extracted' ? r.banked : r.lost).toLocaleString()} cr</b></div>
          <div><span>Loot found</span><b>${r.gained.toLocaleString()} cr</b></div>
        </div>
        <button data-nav data-act="continue" class="m-go primary">Continue</button>
      </div>`;
  }

  // ================================================================ per frame (pad)

  update(dt: number): void {
    if (!this.screen) return;
    this.nav.poll(dt);
    const n = this.nav;
    // LB cycles stash tabs (RB is "split" inside the item board)
    if (this.screen === 'stash' && n.pressed('lb')) {
      const order: StashTab[] = ['loadout', 'trader', 'workshop'];
      this.tab = order[(order.indexOf(this.tab) + 1) % order.length];
      this.render();
      return;
    }
    if (this.board) {
      this.board.pad(n);
      this.board?.refresh();
      return;
    }
    for (const d of ['up', 'down', 'left', 'right'] as const) if (n.pressed(d)) moveFocus(this.root, d);
    if (n.pressed('a')) (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-nav]')?.click();
    if (n.pressed('b')) {
      if (this.screen === 'pause') this.act('resume');
      else if (this.screen !== 'main' && this.screen !== 'results') this.act('back');
    }
    if (n.pressed('menu') && this.screen === 'pause') this.act('resume');
  }
}
