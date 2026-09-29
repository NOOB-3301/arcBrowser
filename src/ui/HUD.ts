import { Events } from '../core/Events';
import { KBM_BINDINGS, type Button, type Input } from '../core/Input';
import type { InputMode } from '../core/Settings';
import { glyph, keyLabel } from './Glyphs';
import { Sfx } from '../audio/Sfx';
import type { PlayerController } from '../player/PlayerController';
import type { CameraRig } from '../camera/CameraRig';

const MODE_LABEL: Record<InputMode, string> = {
  auto: 'Auto',
  kbm: 'Keyboard + Mouse',
  gamepad: 'Controller',
};

const PROMPTS: [Button, string][] = [
  ['jump', 'Jump / Mantle'],
  ['sprint', 'Sprint'],
  ['crouch', 'Crouch / Slide'],
  ['dodge', 'Dodge roll'],
  ['ads', 'Aim'],
  ['fire', 'Fire'],
  ['reload', 'Reload'],
  ['fireMode', 'Fire mode / Ammo'],
  ['swapWeapon', 'Swap weapon'],
  ['heal', 'Heal'],
  ['swapShoulder', 'Swap shoulder'],
  ['freeLook', 'Free look'],
  ['interact', 'Zipline / Ladder'],
  ['map', 'Map'],
  ['pause', 'Pause'], // W5
];

export class HUD {
  private root: HTMLElement;
  private modeChip: HTMLElement;
  private prompts: HTMLElement;
  private toast: HTMLElement;
  private overlay: HTMLElement;
  private debug: HTMLElement;
  private toastTimer = 0;
  private staminaEl: HTMLElement;
  private staminaFill: HTMLElement;

  constructor(private input: Input) {
    this.root = document.getElementById('ui')!;
    this.root.innerHTML = `
      <div class="hud-tag">RUSTFALL <span>alpha</span></div>
      <div class="hud-mode"></div>
      <div class="crosshair"><i></i><i></i><i></i><i></i></div>
      <div class="stamina"><div class="stamina-fill"></div></div>
      <div class="hud-prompts"></div>
      <div class="hud-toast"></div>
      <pre class="hud-debug"></pre>
      <div class="overlay">
        <div class="overlay-card">
          <h1>RUSTFALL</h1>
          <p class="overlay-sub">Click to play · or press any button on a controller</p>
          <p class="overlay-hint">F9 switches input: Auto → Keyboard+Mouse → Controller</p>
        </div>
      </div>`;
    this.modeChip = this.root.querySelector('.hud-mode')!;
    this.prompts = this.root.querySelector('.hud-prompts')!;
    this.toast = this.root.querySelector('.hud-toast')!;
    this.overlay = this.root.querySelector('.overlay')!;
    this.debug = this.root.querySelector('.hud-debug')!;
    this.staminaEl = this.root.querySelector('.stamina')!;
    this.staminaFill = this.root.querySelector('.stamina-fill')!;

    this.overlay.addEventListener('click', () => {
      Sfx.unlock();
      input.requestPointerLock();
    });
    Events.on('toast', (t: string) => this.showToast(t));
    Events.on('player:died', () => this.showToast('You are down'));
    Events.on('input:pointerlock', () => this.refreshOverlay());
    Events.on('input:device', () => {
      this.refresh();
      this.refreshOverlay();
    });
    Events.on('input:mode', (m: InputMode) => {
      this.showToast(`Input: ${MODE_LABEL[m]}`);
      this.refresh();
      this.refreshOverlay();
    });
    Events.on('input:bindings', () => this.refresh()); // W5: key hints follow rebinding
    Events.on('input:pad', (p: { connected: boolean; id?: string }) => {
      this.showToast(p.connected ? `Controller connected` : 'Controller disconnected');
      this.refresh();
      this.refreshOverlay();
    });
    this.refresh();
  }

  /** Playing = pointer locked (KB/M) or controller active. */
  get playing(): boolean {
    return this.input.pointerLocked || (this.input.activeDevice === 'gamepad' && this.input.padConnected);
  }

  update(dt: number, showDebug: boolean, player: PlayerController, rig: CameraRig): void {
    // Stamina: visible only when not full
    const st = player.stamina;
    this.staminaEl.style.opacity = st.fraction < 0.995 ? '1' : '0';
    this.staminaFill.style.width = `${(st.fraction * 100).toFixed(1)}%`;
    this.staminaEl.classList.toggle('exhausted', st.exhausted);


    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.remove('show');
    }
    this.debug.style.display = showDebug ? 'block' : 'none';
    if (showDebug) {
      const i = this.input;
      const held = (['fire', 'ads', 'sprint', 'crouch', 'jump', 'reload', 'interact', 'dodge', 'swapWeapon', 'swapShoulder', 'freeLook', 'heal', 'throwable', 'melee'] as Button[])
        .filter((b) => i.down(b))
        .join(' ');
      this.debug.textContent =
        `device  ${i.activeDevice}${i.activeDevice === 'gamepad' ? ` (${i.padStyle})` : ''}\n` +
        `move    ${i.moveX.toFixed(2)} ${i.moveY.toFixed(2)}\n` +
        `trig    fire ${i.fireAxis.toFixed(2)}  ads ${i.adsAxis.toFixed(2)}\n` +
        `held    ${held || '-'}\n` +
        `key     ${i.lastKeyCode || '-'}\n` +
        `state   ${player.state} / ${player.locomotion}${player.crouched ? ' (crouched)' : ''}\n` +
        `speed   ${player.horizontalSpeed.toFixed(2)} m/s  vy ${player.velocity.y.toFixed(1)}\n` +
        `stamina ${st.value.toFixed(0)}${st.exhausted ? ' EXHAUSTED' : ''}\n` +
        `camera  ${rig.shoulder > 0 ? 'right' : 'left'} shoulder  ads ${rig.ads.toFixed(2)}${rig.firstPerson ? '  FP' : ''}`;
    }
  }

  showToast(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    this.toastTimer = 1.8;
  }

  private refresh(): void {
    const i = this.input;
    const dev = i.activeDevice === 'gamepad' ? 'Controller' : 'KB+M';
    this.modeChip.innerHTML = `<b>F9</b> Input: ${MODE_LABEL[i.mode]}${i.mode === 'auto' ? ` <em>(${dev})</em>` : ''}`;
    // W5: movement keys are rebindable too
    const move =
      i.activeDevice === 'gamepad'
        ? 'LS'
        : (['moveForward', 'moveLeft', 'moveBack', 'moveRight'] as const).map((a) => keyLabel(KBM_BINDINGS[a].find((c) => c) ?? '')).join('');
    this.prompts.innerHTML =
      `<div><kbd>${move}</kbd>Move</div>` +
      PROMPTS.map(([b, label]) => `<div><kbd>${glyph(b, i.activeDevice, i.padStyle)}</kbd>${label}${b === 'pause' && i.activeDevice === 'kbm' ? ' <em>(Esc)</em>' : ''}</div>`).join('');
  }

  private refreshOverlay(): void {
    this.overlay.style.display = this.playing ? 'none' : 'flex';
    const sub = this.overlay.querySelector('.overlay-sub')!;
    sub.textContent =
      this.input.mode === 'gamepad' && !this.input.padConnected
        ? 'Controller mode · connect a controller and press any button'
        : 'Click to play · or press any button on a controller';
  }
}
