import type { Input } from '../core/Input';
import type { RaidManager } from '../raid/RaidManager';
import { Events } from '../core/Events';
import { PadNav, moveFocus } from './PadNav';
import { SettingsUI, type SettingsTab } from './SettingsUI';
import { fmtTime } from './RaidHUD';

/**
 * W5: in-game pause menu. Esc / Pause action / Start button / pointer-lock loss.
 * In a raid it rides RaidManager's pause flag (so the W3 flow — abandon = MIA — is
 * reused); in the ?map=arena sandbox it owns the pause itself. Game skips the
 * simulation while `simPaused` is true.
 */
export interface PauseHost {
  raid(): RaidManager | null;
  /** Gameplay is live and pausing makes sense (in play, alive, no other overlay). */
  canPause(): boolean;
}

export class PauseMenu {
  private root: HTMLElement;
  private nav = new PadNav();
  private confirm: 'abandon' | 'quit' | null = null;
  private isShown = false;
  /** Arena-only pause flag (raids use RaidManager.paused). */
  private localPaused = false;

  constructor(private input: Input, private host: PauseHost) {
    this.root = document.createElement('div');
    this.root.className = 'w5-pause';
    document.body.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (el && !el.hasAttribute('disabled')) this.act(el.dataset.act!);
    });
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Escape' || e.repeat || SettingsUI.isOpen) return;
      if (this.isShown) {
        e.preventDefault();
        if (this.confirm) {
          this.confirm = null;
          this.render();
        } else this.act('resume');
      } else if (this.host.canPause()) {
        e.preventDefault();
        this.pause();
      }
    });
    // Pointer lock lost while playing on KB/M (e.g. Esc, alt-tab). Raids handle this in RaidManager.
    Events.on('input:pointerlock', (locked: boolean) => {
      if (locked || this.host.raid() || this.isShown) return;
      if (this.input.activeDevice === 'kbm' && this.wasPlaying) this.pause();
    });
  }

  /** True while the game simulation should be frozen. */
  get simPaused(): boolean {
    return this.localPaused || (this.host.raid()?.paused ?? false);
  }

  get open(): boolean {
    return this.isShown;
  }

  private wasPlaying = false;

  /** Request a pause (routes through the raid when there is one). */
  pause(): void {
    const raid = this.host.raid();
    if (raid) {
      if (raid.phase === 'raid' && !raid.paused) raid.setPaused(true); // → Menus.showPause → this.show()
      return;
    }
    this.localPaused = true;
    document.body.classList.add('w3-paused', 'w5-paused');
    if (document.pointerLockElement) document.exitPointerLock();
    this.show();
  }

  /** Display the menu (called by Menus.showPause for raids). */
  show(): void {
    this.isShown = true;
    this.confirm = null;
    this.root.classList.add('show');
    this.render();
    this.nav.poll(0);
    this.nav.consume();
    requestAnimationFrame(() => this.root.querySelector<HTMLElement>('[data-nav].primary')?.focus({ preventScroll: true }));
  }

  /** Hide without side effects (RaidManager already unpaused). */
  hide(): void {
    if (!this.isShown) return;
    this.isShown = false;
    this.confirm = null;
    this.root.classList.remove('show');
    this.root.innerHTML = '';
    SettingsUI.close();
  }

  resume(): void {
    const raid = this.host.raid();
    if (raid) {
      raid.setPaused(false); // → Menus.hide → this.hide(); re-locks pointer
      this.hide();
      return;
    }
    this.localPaused = false;
    document.body.classList.remove('w3-paused', 'w5-paused');
    this.hide();
    if (this.input.activeDevice === 'kbm') this.input.requestPointerLock();
  }

  private act(a: string): void {
    const raid = this.host.raid();
    switch (a) {
      case 'resume':
        return this.resume();
      case 'settings':
        return this.openSettings('graphics');
      case 'controls':
        return this.openSettings('bindings');
      case 'abandon':
        if (!raid) return;
        if (this.confirm !== 'abandon') {
          this.confirm = 'abandon';
          return this.render('abandon');
        }
        raid.setPaused(false);
        this.hide();
        raid.endRaid('mia');
        return;
      case 'quit':
        if (this.confirm !== 'quit') {
          this.confirm = 'quit';
          return this.render('quit');
        }
        if (raid) {
          raid.setPaused(false);
          this.hide();
          raid.endRaid('mia');
          raid.toMenu();
        } else {
          // Arena sandbox has no menu of its own: load the default map, which boots to the main menu
          const params = new URLSearchParams(location.search);
          params.delete('map');
          const qs = params.toString();
          location.href = location.pathname + (qs ? `?${qs}` : '');
        }
        return;
    }
  }

  private openSettings(tab: SettingsTab): void {
    this.root.classList.add('under');
    SettingsUI.open({
      tab,
      onClose: () => {
        this.root.classList.remove('under');
        if (!this.isShown) return;
        this.nav.poll(0);
        this.nav.consume();
        this.root.querySelector<HTMLElement>(`[data-act="${tab === 'bindings' ? 'controls' : 'settings'}"]`)?.focus({ preventScroll: true });
      },
    });
  }

  private render(focus?: string): void {
    const raid = this.host.raid();
    const inRaid = !!raid && raid.phase === 'raid';
    const c = this.confirm;
    this.root.innerHTML = `
      <div class="w5-p-card">
        <header><h2>Paused</h2>${inRaid ? `<span class="m-dim">Raid time ${fmtTime(raid!.timeLeft)}</span>` : '<span class="m-dim">Sandbox</span>'}</header>
        <nav class="m-nav">
          <button data-nav data-act="resume" class="primary"><span>Resume</span></button>
          <button data-nav data-act="settings"><span>Settings</span><small>Graphics · controls · audio · accessibility</small></button>
          <button data-nav data-act="controls"><span>Controls</span><small>Key bindings &amp; controller layout</small></button>
          ${inRaid ? `<button data-nav data-act="abandon" class="danger ${c === 'abandon' ? 'armed' : ''}"><span>${c === 'abandon' ? 'Confirm abandon' : 'Abandon raid'}</span><small>Counts as MIA · loadout lost</small></button>` : ''}
          <button data-nav data-act="quit" class="danger ${c === 'quit' ? 'armed' : ''}"><span>${c === 'quit' ? 'Confirm quit' : 'Quit to menu'}</span><small>${inRaid ? 'Leaves the raid · loadout lost' : 'Back to the main menu'}</small></button>
        </nav>
        <footer class="m-dim">${this.input.padConnected ? '<kbd>A</kbd>Select <kbd>B</kbd>Resume' : '<kbd>Esc</kbd>Resume'}</footer>
      </div>`;
    if (focus) this.root.querySelector<HTMLElement>(`[data-act="${focus}"]`)?.focus({ preventScroll: true });
  }

  /** Per frame (always called by Game, paused or not). */
  update(dt: number): void {
    // Remember whether we were in live play, so a pointer-lock loss can pause
    this.wasPlaying = this.host.canPause();
    if (!this.isShown) {
      // Arena: Pause action (P / Start) — raids read it in RaidManager
      if (!this.host.raid() && this.input.pressed('pause') && this.host.canPause()) this.pause();
      return;
    }
    if (SettingsUI.isOpen) return;
    this.nav.poll(dt);
    const n = this.nav;
    for (const d of ['up', 'down', 'left', 'right'] as const) if (n.pressed(d)) moveFocus(this.root, d);
    if (n.pressed('a')) {
      const el = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-nav]');
      if (el && this.root.contains(el)) el.click();
      else this.root.querySelector<HTMLElement>('[data-nav]')?.focus();
    }
    if (n.pressed('b') || n.pressed('menu') || this.input.pressed('pause')) {
      if (this.confirm && n.pressed('b')) {
        this.confirm = null;
        this.render();
      } else this.act('resume');
    }
  }
}
