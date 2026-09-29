import { Settings, type ColorblindMode, type InputMode, type SettingsData } from '../core/Settings';
import { Events } from '../core/Events';
import {
  Bindings, BUTTONS, Input, KBM_BINDINGS, KBM_SLOTS, PAD_BINDINGS, RESERVED_CODES,
  type Button, type KbmAction, type KbmConflict, type PadBind,
} from '../core/Input';
import { QUALITY_PRESETS, Quality, setQuality, type QualityLevel } from '../render/Quality';
import { PadNav, moveFocus } from './PadNav';
import { keyLabel, padButtonName, padLabel } from './Glyphs';

/**
 * W5: tabbed settings screen (graphics, controls, key bindings, audio, accessibility).
 * One overlay shared by the main menu and the pause menu. Mouse, keyboard and gamepad.
 */

export type SettingsTab = 'graphics' | 'controls' | 'bindings' | 'audio' | 'access';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'graphics', label: 'Graphics' },
  { id: 'controls', label: 'Controls' },
  { id: 'bindings', label: 'Key bindings' },
  { id: 'audio', label: 'Audio' },
  { id: 'access', label: 'Accessibility' },
];

export const ACTION_LABELS: Record<KbmAction, string> = {
  moveForward: 'Move forward', moveBack: 'Move back', moveLeft: 'Move left', moveRight: 'Move right',
  jump: 'Jump / Mantle', sprint: 'Sprint', crouch: 'Crouch / Slide', dodge: 'Dodge roll', freeLook: 'Free look',
  fire: 'Fire', ads: 'Aim down sights', reload: 'Reload', fireMode: 'Fire mode / Ammo', swapWeapon: 'Swap weapon',
  slot1: 'Weapon slot 1', slot2: 'Weapon slot 2', throwable: 'Throwable', melee: 'Melee', heal: 'Heal',
  swapShoulder: 'Swap shoulder', interact: 'Interact / Search', inventory: 'Inventory', map: 'Map',
  pause: 'Pause menu', toggleView: 'First / third person',
};

const GROUPS: { title: string; actions: KbmAction[] }[] = [
  { title: 'Movement', actions: ['moveForward', 'moveBack', 'moveLeft', 'moveRight', 'jump', 'sprint', 'crouch', 'dodge', 'freeLook'] },
  { title: 'Combat', actions: ['fire', 'ads', 'reload', 'fireMode', 'swapWeapon', 'slot1', 'slot2', 'throwable', 'melee', 'heal', 'swapShoulder'] },
  { title: 'Interface', actions: ['interact', 'inventory', 'map', 'pause', 'toggleView'] },
];

const CB_MODES: { id: ColorblindMode; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'deuter', label: 'Deuteranopia' },
  { id: 'prot', label: 'Protanopia' },
  { id: 'trit', label: 'Tritanopia' },
];

const CROSSHAIRS = ['#f1ead8', '#ffffff', '#5cffb0', '#ffe14a', '#4fd2ff', '#ff5ad2', '#ff5a45'];

type NumKey = { [K in keyof SettingsData]: SettingsData[K] extends number ? K : never }[keyof SettingsData];
type BoolKey = { [K in keyof SettingsData]: SettingsData[K] extends boolean ? K : never }[keyof SettingsData];

interface SliderSpec {
  key: NumKey;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt?: (v: number) => string;
  hint?: string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const x2 = (v: number) => v.toFixed(2);

type Capture =
  | { kind: 'kbm'; action: KbmAction; slot: number; msg?: string }
  | { kind: 'pad'; action: Button; phase: 'release' | 'wait' | 'hold'; btn: number; t: number };

type Pending =
  | { kind: 'kbm'; action: KbmAction; slot: number; code: string; conflicts: KbmConflict[] }
  | { kind: 'pad'; action: Button; bind: PadBind; conflicts: Button[] };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

class SettingsScreen {
  private root: HTMLElement;
  private tab: SettingsTab = 'graphics';
  private onClose: (() => void) | null = null;
  private nav = new PadNav();
  private raf = 0;
  private last = 0;
  private capture: Capture | null = null;
  private pending: Pending | null = null;
  private confirmResetAll = false;
  private captureCleanup: (() => void) | null = null;
  /** data-id of the cell to refocus after a capture / dialog. */
  private returnFocus = '';
  isOpen = false;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'w5-settings';
    document.body.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (el && !el.hasAttribute('disabled')) this.act(el.dataset.act!, el.dataset.arg ?? '');
    });
    this.root.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.slider) this.onSlider(el);
      if (el.dataset.color) this.setAndRender('crosshairColor', el.value);
    });
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen || this.capture || e.code !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.back();
    });
    Events.on('input:mode', () => this.isOpen && this.tab === 'controls' && this.render());
    Events.on('input:pad', () => this.isOpen && this.render());
  }

  open(opts: { tab?: SettingsTab; onClose?: () => void } = {}): void {
    if (opts.tab) this.tab = opts.tab;
    this.onClose = opts.onClose ?? null;
    this.isOpen = true;
    this.pending = null;
    this.confirmResetAll = false;
    this.root.classList.add('show');
    this.render();
    this.focusFirst();
    // Swallow the pad button that opened us
    this.nav.poll(0);
    this.nav.consume();
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    const loop = (t: number) => {
      if (!this.isOpen) return;
      const dt = Math.min(0.1, (t - this.last) / 1000);
      this.last = t;
      this.tick(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  close(): void {
    if (!this.isOpen) return;
    this.endCapture();
    this.isOpen = false;
    this.pending = null;
    cancelAnimationFrame(this.raf);
    this.root.classList.remove('show');
    this.root.innerHTML = '';
    const cb = this.onClose;
    this.onClose = null;
    cb?.();
  }

  private back(): void {
    if (this.pending) {
      this.pending = null;
      this.render();
      this.refocus();
    } else if (this.confirmResetAll) {
      this.confirmResetAll = false;
      this.render();
    } else this.close();
  }

  // ================================================================ actions

  private act(a: string, arg: string): void {
    const input = Input.instance;
    switch (a) {
      case 'close':
        return this.close();
      case 'tab':
        this.tab = arg as SettingsTab;
        this.confirmResetAll = false;
        this.render();
        this.root.querySelector<HTMLElement>(`[data-act="tab"][data-arg="${arg}"]`)?.focus();
        return;
      case 'toggle': {
        const k = arg as BoolKey;
        return this.setAndRender(k, !Settings.get(k));
      }
      case 'quality': {
        const q = arg as QualityLevel;
        Settings.set('graphicsQuality', q);
        setQuality(q);
        return this.render();
      }
      case 'mode':
        if (input) input.setMode(arg as InputMode);
        else Settings.set('inputMode', arg as InputMode);
        return this.render();
      case 'aim-assist': {
        const on = Settings.get('aimAssist') > 0;
        Settings.set('aimAssist', on ? 0 : Math.max(0.05, Settings.get('aimAssistStrength')));
        return this.render();
      }
      case 'cb':
        return this.setAndRender('colorblind', arg as ColorblindMode);
      case 'xh':
        return this.setAndRender('crosshairColor', arg);
      case 'reset-tab':
        this.resetTab();
        return this.render();
      case 'bind-kbm': {
        const [action, slot] = arg.split(':');
        return this.startKbmCapture(action as KbmAction, Number(slot));
      }
      case 'bind-pad':
        return this.startPadCapture(arg as Button);
      case 'capture-cancel':
        this.endCapture();
        this.render();
        return this.refocus();
      case 'capture-clear': {
        const c = this.capture;
        this.endCapture();
        if (c?.kind === 'kbm') Bindings.setKbm(c.action, c.slot, '');
        else if (c?.kind === 'pad') Bindings.setPad(c.action, null);
        this.render();
        return this.refocus();
      }
      case 'reset-action':
        Bindings.resetAction(arg as KbmAction);
        this.render();
        return this.refocus(`reset:${arg}`);
      case 'reset-all':
        if (!this.confirmResetAll) {
          this.confirmResetAll = true;
          this.render();
          this.root.querySelector<HTMLElement>('[data-act="reset-all"]')?.focus();
          return;
        }
        this.confirmResetAll = false;
        Bindings.resetAll();
        this.render();
        return;
      case 'conflict':
        return this.resolveConflict(arg as 'swap' | 'clear' | 'cancel');
    }
  }

  private setAndRender<K extends keyof SettingsData>(k: K, v: SettingsData[K]): void {
    Settings.set(k, v);
    this.render();
  }

  private onSlider(el: HTMLInputElement): void {
    const k = el.dataset.slider as NumKey;
    const v = Number(el.value);
    Settings.set(k, v as never);
    if (k === 'aimAssistStrength' && Settings.get('aimAssist') > 0) Settings.set('aimAssist', v);
    const out = el.parentElement?.querySelector('output');
    const spec = SLIDERS[k];
    if (out) out.textContent = spec?.fmt ? spec.fmt(v) : String(v);
  }

  private resetTab(): void {
    switch (this.tab) {
      case 'graphics':
        Settings.reset(['graphicsQuality', 'fov', 'dynamicRes', 'showFps', 'showDebug', 'cameraShake']);
        setQuality(Settings.get('graphicsQuality'));
        return;
      case 'controls':
        Settings.reset(['mouseSensitivity', 'adsSensitivityMultiplier', 'invertY', 'gamepadSensitivityX', 'gamepadSensitivityY', 'stickDeadzone', 'aimAssist', 'aimAssistStrength', 'rumble']);
        Input.instance?.setMode('auto');
        return;
      case 'bindings':
        Bindings.resetAll();
        return;
      case 'audio':
        Settings.reset(['volMaster', 'volSfx', 'volMusic', 'volUi']);
        return;
      case 'access':
        Settings.reset(['colorblind', 'crosshairColor']);
        return;
    }
  }

  // ================================================================ binding capture

  private startKbmCapture(action: KbmAction, slot: number): void {
    this.endCapture();
    this.pending = null;
    this.returnFocus = `kbm:${action}:${slot}`;
    this.capture = { kind: 'kbm', action, slot };
    if (Input.instance) Input.instance.capturing = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
    this.render();
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      let code = e.code || e.key;
      if (e.key === 'Control' || code.startsWith('Control')) code = 'Control';
      if (code === 'Escape') return this.act('capture-cancel', '');
      if (code === 'Delete') return this.act('capture-clear', '');
      if (RESERVED_CODES.includes(code)) {
        if (this.capture?.kind === 'kbm') this.capture.msg = `${keyLabel(code)} is reserved`;
        this.render();
        return;
      }
      this.finishKbm(code);
    };
    const onMouse = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.('.w5-s-modal [data-act]')) return; // Cancel / Clear buttons
      e.preventDefault();
      e.stopImmediatePropagation();
      this.finishKbm(`Mouse${e.button}`);
    };
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 1) return;
      e.preventDefault();
      this.finishKbm('Wheel');
    };
    const onCtx = (e: Event) => e.preventDefault();
    // Attach after the click that started the capture has finished dispatching
    const timer = window.setTimeout(() => {
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('mousedown', onMouse, true);
      window.addEventListener('wheel', onWheel, { capture: true, passive: false });
      window.addEventListener('contextmenu', onCtx, true);
    }, 0);
    this.captureCleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('wheel', onWheel, true);
      // keep blocking the context menu for the right-click that just ended
      setTimeout(() => window.removeEventListener('contextmenu', onCtx, true), 300);
    };
  }

  private startPadCapture(action: Button): void {
    this.endCapture();
    this.pending = null;
    this.returnFocus = `pad:${action}`;
    this.capture = { kind: 'pad', action, phase: 'release', btn: -1, t: 0 };
    if (Input.instance) Input.instance.capturing = true;
    // Esc (keyboard) still cancels a pad capture
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape' && e.code !== 'Delete') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.act(e.code === 'Escape' ? 'capture-cancel' : 'capture-clear', '');
    };
    window.addEventListener('keydown', onKey, true);
    this.captureCleanup = () => window.removeEventListener('keydown', onKey, true);
    this.render();
  }

  private endCapture(): void {
    this.captureCleanup?.();
    this.captureCleanup = null;
    this.capture = null;
    if (Input.instance) Input.instance.capturing = false;
  }

  private finishKbm(code: string): void {
    const c = this.capture;
    if (c?.kind !== 'kbm') return;
    this.endCapture();
    const { action, slot } = c;
    const own = KBM_BINDINGS[action];
    // Already bound to this action (other slot): move it here
    const otherSlot = own.findIndex((x, i) => i !== slot && x === code);
    if (otherSlot >= 0) Bindings.setKbm(action, otherSlot, own[slot] ?? '');
    const conflicts = Bindings.kbmConflicts(code, action);
    if (conflicts.length) {
      this.pending = { kind: 'kbm', action, slot, code, conflicts };
      this.render();
      this.root.querySelector<HTMLElement>('.w5-s-modal [data-arg="swap"]')?.focus();
      return;
    }
    Bindings.setKbm(action, slot, code);
    this.render();
    this.refocus();
  }

  private finishPad(bind: PadBind): void {
    const c = this.capture;
    if (c?.kind !== 'pad') return;
    this.endCapture();
    const conflicts = Bindings.padConflicts(bind, c.action);
    if (conflicts.length) {
      this.pending = { kind: 'pad', action: c.action, bind, conflicts };
      this.render();
      this.root.querySelector<HTMLElement>('.w5-s-modal [data-arg="swap"]')?.focus();
      return;
    }
    Bindings.setPad(c.action, bind);
    this.render();
    this.refocus();
    this.primeNav();
  }

  private resolveConflict(how: 'swap' | 'clear' | 'cancel'): void {
    const p = this.pending;
    this.pending = null;
    if (p && how !== 'cancel') {
      if (p.kind === 'kbm') {
        const old = KBM_BINDINGS[p.action][p.slot] ?? '';
        // resolve from the highest slot down so compaction can't shift pending indices
        for (const c of [...p.conflicts].sort((a, b) => b.slot - a.slot)) Bindings.setKbm(c.action, c.slot, how === 'swap' ? old : '');
        Bindings.setKbm(p.action, p.slot, p.code);
      } else {
        const old = Bindings.pad(p.action);
        for (const b of p.conflicts) Bindings.setPad(b, how === 'swap' && old ? old : null);
        Bindings.setPad(p.action, p.bind);
      }
    }
    this.render();
    this.refocus();
    this.primeNav();
  }

  /** Pad capture state machine: wait for release, take the next press; long press = Hold binding. */
  private tickPadCapture(dt: number): void {
    const c = this.capture;
    if (c?.kind !== 'pad') return;
    const pad = [...(navigator.getGamepads?.() ?? [])].find((p) => p && p.connected) ?? null;
    if (!pad) return;
    const down = pad.buttons.map((b, i) => (i === 6 || i === 7 ? b.value > 0.35 : b.pressed));
    const any = down.findIndex((d) => d);
    if (c.phase === 'release') {
      if (any < 0) c.phase = 'wait';
      return;
    }
    if (c.phase === 'wait') {
      if (any >= 0) {
        c.phase = 'hold';
        c.btn = any;
        c.t = 0;
        this.render();
      }
      return;
    }
    c.t += dt;
    const bar = this.root.querySelector<HTMLElement>('.w5-hold-bar i');
    if (bar) bar.style.width = `${Math.min(100, (c.t / 0.35) * 100)}%`;
    if (!down[c.btn]) {
      let mode: PadBind['mode'] = c.t >= 0.35 ? 'hold' : 'press';
      // Short press on a button that already carries a Hold action becomes its Tap
      if (mode === 'press' && BUTTONS.some((b) => b !== c.action && PAD_BINDINGS[b].some((pb) => pb.btn === c.btn && pb.mode === 'hold'))) mode = 'tap';
      this.finishPad({ btn: c.btn, mode });
    }
  }

  private primeNav(): void {
    this.nav.poll(0);
    this.nav.consume();
  }

  // ================================================================ per frame (pad)

  private tick(dt: number): void {
    if (this.capture) {
      this.tickPadCapture(dt);
      return;
    }
    this.nav.poll(dt);
    const n = this.nav;
    if (!n.active && !this.anyPadEdge()) return;
    const scope = this.root.querySelector<HTMLElement>('.w5-s-modal') ?? this.root;
    if (!this.pending) {
      if (n.pressed('lb') || n.pressed('rb')) {
        const i = TABS.findIndex((t) => t.id === this.tab);
        const next = TABS[(i + (n.pressed('rb') ? 1 : TABS.length - 1)) % TABS.length];
        this.act('tab', next.id);
        return;
      }
    }
    const focused = document.activeElement as HTMLElement | null;
    for (const d of ['up', 'down', 'left', 'right'] as const) {
      if (!n.pressed(d)) continue;
      if ((d === 'left' || d === 'right') && focused instanceof HTMLInputElement && focused.type === 'range' && this.root.contains(focused)) {
        this.nudge(focused, d === 'right' ? 1 : -1);
      } else moveFocus(scope, d);
    }
    if (n.pressed('a')) {
      const el = focused?.closest<HTMLElement>('[data-nav]');
      if (el && this.root.contains(el)) {
        if (el instanceof HTMLInputElement && el.type === 'range') this.nudge(el, 1);
        else el.click();
      } else this.focusFirst();
    }
    if (n.pressed('x') && focused?.dataset.act === 'bind-kbm') {
      const [action, slot] = (focused.dataset.arg ?? '').split(':');
      Bindings.setKbm(action as KbmAction, Number(slot), '');
      this.render();
      this.refocus(focused.dataset.id);
    } else if (n.pressed('x') && focused?.dataset.act === 'bind-pad') {
      Bindings.setPad(focused.dataset.arg as Button, null);
      this.render();
      this.refocus(focused.dataset.id);
    }
    if (n.pressed('y') && this.tab === 'bindings' && !this.pending) this.act('reset-all', '');
    if (n.pressed('b')) this.back();
  }

  private anyPadEdge(): boolean {
    return (['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'lb', 'rb'] as const).some((b) => this.nav.pressed(b));
  }

  private nudge(el: HTMLInputElement, dir: number): void {
    const min = Number(el.min);
    const max = Number(el.max);
    const step = Math.max(Number(el.step), (max - min) / 20);
    const v = Math.min(max, Math.max(min, Number(el.value) + dir * step));
    el.value = String(Math.round(v / Number(el.step)) * Number(el.step));
    this.onSlider(el);
  }

  private focusFirst(): void {
    requestAnimationFrame(() => {
      const el =
        this.root.querySelector<HTMLElement>('.w5-s-modal [data-nav]') ??
        this.root.querySelector<HTMLElement>('.w5-s-body [data-nav]') ??
        this.root.querySelector<HTMLElement>('[data-nav]');
      el?.focus({ preventScroll: true });
    });
  }

  private refocus(id = this.returnFocus): void {
    const el = id ? this.root.querySelector<HTMLElement>(`[data-id="${id}"]`) : null;
    if (el) el.focus({ preventScroll: false });
    else this.focusFirst();
  }

  // ================================================================ render

  private render(): void {
    if (!this.isOpen) return;
    const active = document.activeElement as HTMLElement | null;
    const focusId = active && this.root.contains(active) ? active.dataset.id : undefined;
    const scrollTop = this.root.querySelector('.w5-s-body')?.scrollTop ?? 0;
    const tabs = TABS.map(
      (t) => `<button data-nav data-id="tab:${t.id}" data-act="tab" data-arg="${t.id}" class="m-tab ${this.tab === t.id ? 'on' : ''}">${t.label}</button>`,
    ).join('');
    const pad = Input.instance?.padConnected ?? false;
    this.root.innerHTML = `
      <div class="w5-s-panel" role="dialog" aria-label="Settings">
        <header class="w5-s-head">
          <h2>Settings</h2>
          <nav class="m-tabs w5-s-tabs">${pad ? '<kbd class="w5-bumper">LB</kbd>' : ''}${tabs}${pad ? '<kbd class="w5-bumper">RB</kbd>' : ''}</nav>
          <button data-nav data-id="close" data-act="close" class="m-back">Back</button>
        </header>
        <div class="w5-s-body">${this.renderTab()}</div>
        <footer class="w5-s-foot">
          <span>${pad ? '<kbd>A</kbd>Select <kbd>B</kbd>Back <kbd>LB</kbd><kbd>RB</kbd>Tabs <kbd>←→</kbd>Adjust' : '<kbd>Esc</kbd>Back · changes apply and save instantly'}</span>
          <button data-nav data-id="reset-tab" data-act="reset-tab" class="w5-link">Reset ${TABS.find((t) => t.id === this.tab)!.label.toLowerCase()} to defaults</button>
        </footer>
      </div>
      ${this.renderModal()}`;
    const body = this.root.querySelector('.w5-s-body');
    if (body) body.scrollTop = scrollTop;
    if (focusId && !this.root.querySelector('.w5-s-modal')) this.root.querySelector<HTMLElement>(`[data-id="${focusId}"]`)?.focus({ preventScroll: true });
  }

  private renderTab(): string {
    switch (this.tab) {
      case 'graphics':
        return this.renderGraphics();
      case 'controls':
        return this.renderControls();
      case 'bindings':
        return this.renderBindings();
      case 'audio':
        return this.renderAudio();
      case 'access':
        return this.renderAccess();
    }
  }

  private section(title: string, rows: string, note = ''): string {
    return `<section class="w5-s-sec"><h4>${title}</h4>${rows}${note ? `<p class="m-dim w5-note">${note}</p>` : ''}</section>`;
  }

  private slider(k: NumKey): string {
    const s = SLIDERS[k]!;
    const v = Settings.get(k);
    return `<label class="w5-row"><span class="w5-label">${s.label}${s.hint ? `<small>${s.hint}</small>` : ''}</span>
      <span class="w5-ctl"><input type="range" data-nav data-id="sl:${k}" data-slider="${k}" min="${s.min}" max="${s.max}" step="${s.step}" value="${v}"><output>${s.fmt ? s.fmt(v) : v}</output></span></label>`;
  }

  private toggle(k: BoolKey, label: string, hint = ''): string {
    const on = Settings.get(k);
    return `<div class="w5-row"><span class="w5-label">${label}${hint ? `<small>${hint}</small>` : ''}</span>
      <span class="w5-ctl"><button data-nav data-id="tg:${k}" data-act="toggle" data-arg="${k}" class="w5-switch ${on ? 'on' : ''}" aria-pressed="${on}"><i></i><b>${on ? 'On' : 'Off'}</b></button></span></div>`;
  }

  private seg(id: string, label: string, opts: { v: string; label: string }[], cur: string, act: string, hint = ''): string {
    return `<div class="w5-row"><span class="w5-label">${label}${hint ? `<small>${hint}</small>` : ''}</span>
      <span class="w5-ctl"><span class="w5-seg">${opts
        .map((o) => `<button data-nav data-id="${id}:${o.v}" data-act="${act}" data-arg="${o.v}" class="${o.v === cur ? 'on' : ''}">${o.label}</button>`)
        .join('')}</span></span></div>`;
  }

  private renderGraphics(): string {
    const q = Quality.level;
    return (
      this.section(
        'Display',
        this.seg('q', 'Quality preset', (Object.keys(QUALITY_PRESETS) as QualityLevel[]).map((k) => ({ v: k, label: QUALITY_PRESETS[k].label })), q, 'quality', 'Shadows, AO, bloom, grass, draw distance') +
          this.slider('fov') +
          this.toggle('dynamicRes', 'Dynamic resolution', 'Lowers render scale when frames run slow') +
          this.slider('cameraShake'),
        'Post-processing, shadows and draw distance switch live. Grass density and texture detail fully apply on the next raid / reload.',
      ) +
      this.section('Overlays', this.toggle('showFps', 'FPS counter') + this.toggle('showDebug', 'Debug overlay', 'Input / movement readout'))
    );
  }

  private renderControls(): string {
    const input = Input.instance;
    const mode = Settings.get('inputMode');
    const dev = input?.activeDevice === 'gamepad' ? 'controller' : 'keyboard + mouse';
    const aaOn = Settings.get('aimAssist') > 0;
    return (
      this.section(
        'Input device',
        this.seg('mode', 'Input mode', [
          { v: 'auto', label: 'Auto' },
          { v: 'kbm', label: 'KB + Mouse' },
          { v: 'gamepad', label: 'Controller' },
        ], mode, 'mode', `F9 cycles · active: ${dev}${input?.padConnected ? '' : ' · no controller detected'}`),
      ) +
      this.section('Mouse', this.slider('mouseSensitivity') + this.slider('adsSensitivityMultiplier') + this.toggle('invertY', 'Invert look Y')) +
      this.section(
        'Controller',
        this.slider('gamepadSensitivityX') +
          this.slider('gamepadSensitivityY') +
          this.slider('stickDeadzone') +
          `<div class="w5-row"><span class="w5-label">Aim assist<small>Controller only · slows and nudges aim near targets</small></span>
            <span class="w5-ctl"><button data-nav data-id="aa" data-act="aim-assist" class="w5-switch ${aaOn ? 'on' : ''}" aria-pressed="${aaOn}"><i></i><b>${aaOn ? 'On' : 'Off'}</b></button></span></div>` +
          (aaOn ? this.slider('aimAssistStrength') : '') +
          this.toggle('rumble', 'Vibration'),
      )
    );
  }

  private renderBindings(): string {
    const input = Input.instance;
    const style = input?.padConnected ? input.padStyle : 'xbox';
    const cap = this.capture;
    const cell = (a: KbmAction, slot: number) => {
      const code = KBM_BINDINGS[a][slot] ?? '';
      const capturing = cap?.kind === 'kbm' && cap.action === a && cap.slot === slot;
      return `<button data-nav data-id="kbm:${a}:${slot}" data-act="bind-kbm" data-arg="${a}:${slot}" class="w5-key ${code ? '' : 'empty'} ${capturing ? 'cap' : ''}" title="Click, then press a key or mouse button">${capturing ? 'Press…' : code ? esc(keyLabel(code)) : '—'}</button>`;
    };
    const padCell = (a: KbmAction) => {
      if (!(BUTTONS as string[]).includes(a)) return `<span class="w5-key fixed">Left stick</span>`;
      const b = PAD_BINDINGS[a as Button][0];
      const capturing = cap?.kind === 'pad' && cap.action === a;
      const tag = b?.mode === 'tap' ? '<em>tap</em>' : '';
      return `<button data-nav data-id="pad:${a}" data-act="bind-pad" data-arg="${a}" class="w5-key pad ${b ? '' : 'empty'} ${capturing ? 'cap' : ''}">${capturing ? 'Press…' : `${esc(padLabel(b, style))}${tag}`}</button>`;
    };
    const rows = (actions: KbmAction[]) =>
      actions
        .map((a) => {
          const def = Bindings.isDefault(a);
          return `<div class="w5-bind">
            <span class="w5-label">${ACTION_LABELS[a]}</span>
            ${Array.from({ length: KBM_SLOTS }, (_, i) => cell(a, i)).join('')}
            ${padCell(a)}
            <button data-nav data-id="reset:${a}" data-act="reset-action" data-arg="${a}" class="w5-reset" title="Reset to default" ${def ? 'disabled' : ''}>↺</button>
          </div>`;
        })
        .join('');
    return `
      <div class="w5-bind-top">
        <p class="m-dim">Click a slot, then press a key or mouse button (Esc cancels, Del clears). Controller: select the pad slot and press a button · hold it for a <b>Hold</b> binding.</p>
        <button data-nav data-id="reset-all" data-act="reset-all" class="m-mini ${this.confirmResetAll ? 'w5-danger' : ''}">${this.confirmResetAll ? 'Confirm reset all?' : 'Reset all'}</button>
      </div>
      <div class="w5-bind w5-bind-head"><span></span><span>Primary</span><span>Alternate</span><span>Controller</span><span></span></div>
      ${GROUPS.map((g) => `<section class="w5-s-sec"><h4>${g.title}</h4>${rows(g.actions)}</section>`).join('')}`;
  }

  private renderAudio(): string {
    return this.section('Volume', this.slider('volMaster') + this.slider('volSfx') + this.slider('volMusic') + this.slider('volUi'));
  }

  private renderAccess(): string {
    const cb = Settings.get('colorblind');
    const xh = Settings.get('crosshairColor');
    const swatches = ['good', 'bad', 'warn', 'head', 'kill']
      .map((k) => `<i style="background: var(--${k === 'head' || k === 'kill' ? 'w5' : 'w3'}-${k})" title="${k}"></i>`)
      .join('');
    return (
      this.section(
        'Colour vision',
        this.seg('cb', 'Marker palette', CB_MODES.map((m) => ({ v: m.id, label: m.label })), cb, 'cb', 'Extract / danger / warning / hit markers') +
          `<div class="w5-row"><span class="w5-label">Preview<small>Extract · danger · warning · headshot · kill</small></span><span class="w5-ctl"><span class="w5-swatches">${swatches}</span></span></div>`,
      ) +
      this.section(
        'Crosshair',
        `<div class="w5-row"><span class="w5-label">Crosshair colour</span><span class="w5-ctl"><span class="w5-colors">${CROSSHAIRS.map(
          (c) => `<button data-nav data-id="xh:${c}" data-act="xh" data-arg="${c}" class="${c === xh ? 'on' : ''}" style="--c:${c}" aria-label="${c}"></button>`,
        ).join('')}<input type="color" data-nav data-id="xh-custom" data-color value="${/^#[0-9a-f]{6}$/i.test(xh) ? xh : '#f1ead8'}" title="Custom colour"></span></span></div>
        <div class="w5-row"><span class="w5-label">Preview</span><span class="w5-ctl"><span class="w5-xh-preview"><span class="crosshair"><i></i><i></i><i></i><i></i></span></span></span></div>`,
      )
    );
  }

  private renderModal(): string {
    const style = Input.instance?.padConnected ? Input.instance.padStyle : 'xbox';
    const c = this.capture;
    if (c?.kind === 'kbm') {
      return `<div class="w5-s-modal"><div class="w5-s-dialog">
        <small>Rebind · ${c.slot === 0 ? 'primary' : 'alternate'}</small>
        <h3>${ACTION_LABELS[c.action]}</h3>
        <p>Press a key or mouse button</p>
        ${c.msg ? `<p class="m-warn">${esc(c.msg)}</p>` : ''}
        <div class="w5-s-actions"><button data-nav data-act="capture-clear" class="m-mini">Clear (Del)</button><button data-nav data-act="capture-cancel" class="m-back">Cancel (Esc)</button></div>
      </div></div>`;
    }
    if (c?.kind === 'pad') {
      const has = Input.instance?.padConnected;
      return `<div class="w5-s-modal"><div class="w5-s-dialog">
        <small>Rebind · controller</small>
        <h3>${ACTION_LABELS[c.action]}</h3>
        <p>${!has ? 'No controller detected — connect one and press a button' : c.phase === 'hold' ? `${esc(padButtonName(c.btn, style))} · keep holding for a Hold binding` : c.phase === 'release' ? 'Release all buttons…' : 'Press a controller button'}</p>
        <div class="w5-hold-bar"><i></i></div>
        <div class="w5-s-actions"><button data-nav data-act="capture-clear" class="m-mini">Clear (Del)</button><button data-nav data-act="capture-cancel" class="m-back">Cancel (Esc)</button></div>
      </div></div>`;
    }
    const p = this.pending;
    if (p) {
      const what = p.kind === 'kbm' ? keyLabel(p.code) : padLabel(p.bind, style);
      const others = p.kind === 'kbm' ? [...new Set(p.conflicts.map((x) => ACTION_LABELS[x.action]))] : p.conflicts.map((b) => ACTION_LABELS[b]);
      const old = p.kind === 'kbm' ? KBM_BINDINGS[p.action][p.slot] ?? '' : '';
      const oldPad = p.kind === 'pad' ? Bindings.pad(p.action) : null;
      const swapTo = p.kind === 'kbm' ? (old ? keyLabel(old) : 'nothing') : oldPad ? padLabel(oldPad, style) : 'nothing';
      return `<div class="w5-s-modal"><div class="w5-s-dialog warn">
        <small>Binding conflict</small>
        <h3>${esc(what)} is already used</h3>
        <p>by <b>${others.map(esc).join(', ')}</b>. Assign it to <b>${ACTION_LABELS[p.action]}</b>?</p>
        <div class="w5-s-actions">
          <button data-nav data-act="conflict" data-arg="swap" class="m-mini">Swap (${esc(others[0] ?? '')} → ${esc(swapTo)})</button>
          <button data-nav data-act="conflict" data-arg="clear" class="m-mini">Unbind other</button>
          <button data-nav data-act="conflict" data-arg="cancel" class="m-back">Cancel</button>
        </div>
      </div></div>`;
    }
    return '';
  }
}

const SLIDERS: Partial<Record<NumKey, SliderSpec>> = {
  fov: { key: 'fov', label: 'Field of view', min: 55, max: 100, step: 1, fmt: (v) => `${v}°` },
  cameraShake: { key: 'cameraShake', label: 'Camera shake', min: 0, max: 1.5, step: 0.05, fmt: pct, hint: 'Explosions, recoil, landings' },
  mouseSensitivity: { key: 'mouseSensitivity', label: 'Mouse sensitivity', min: 0.1, max: 4, step: 0.05, fmt: x2 },
  adsSensitivityMultiplier: { key: 'adsSensitivityMultiplier', label: 'Aim (ADS) sensitivity', min: 0.2, max: 1, step: 0.05, fmt: (v) => `×${v.toFixed(2)}`, hint: 'Multiplier while aiming' },
  gamepadSensitivityX: { key: 'gamepadSensitivityX', label: 'Look sensitivity · horizontal', min: 0.1, max: 4, step: 0.05, fmt: x2 },
  gamepadSensitivityY: { key: 'gamepadSensitivityY', label: 'Look sensitivity · vertical', min: 0.1, max: 4, step: 0.05, fmt: x2 },
  stickDeadzone: { key: 'stickDeadzone', label: 'Stick deadzone', min: 0, max: 0.5, step: 0.01, fmt: pct },
  aimAssistStrength: { key: 'aimAssistStrength', label: 'Aim assist strength', min: 0.05, max: 1, step: 0.05, fmt: pct },
  volMaster: { key: 'volMaster', label: 'Master', min: 0, max: 1, step: 0.01, fmt: pct },
  volSfx: { key: 'volSfx', label: 'Effects', min: 0, max: 1, step: 0.01, fmt: pct },
  volMusic: { key: 'volMusic', label: 'Music', min: 0, max: 1, step: 0.01, fmt: pct },
  volUi: { key: 'volUi', label: 'Interface', min: 0, max: 1, step: 0.01, fmt: pct },
};

let screen: SettingsScreen | null = null;

/** Shared settings overlay. */
export const SettingsUI = {
  open(opts?: { tab?: SettingsTab; onClose?: () => void }): void {
    (screen ??= new SettingsScreen()).open(opts);
  },
  close(): void {
    screen?.close();
  },
  get isOpen(): boolean {
    return screen?.isOpen ?? false;
  },
};

// ---------------------------------------------------------------- live visual settings

/** Apply the settings that live in CSS (colour-blind palette, crosshair, FPS panel). */
export function applyVisualSettings(): void {
  const b = document.body;
  if (!b) return;
  const cb = Settings.get('colorblind');
  if (cb === 'off') delete b.dataset.cb;
  else b.dataset.cb = cb;
  b.style.setProperty('--w5-crosshair', Settings.get('crosshairColor'));
  b.classList.toggle('w5-nofps', !Settings.get('showFps'));
}

applyVisualSettings();
Events.on('settings:changed', ({ key }: { key: keyof SettingsData }) => {
  if (key === 'colorblind' || key === 'crosshairColor' || key === 'showFps') applyVisualSettings();
});
