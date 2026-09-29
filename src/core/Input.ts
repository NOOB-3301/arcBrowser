import { Events } from './Events';
import { Settings, type InputMode } from './Settings';

/**
 * Action-based input. Gameplay reads actions (never raw keys), so keyboard+mouse
 * and gamepad are interchangeable. Input mode is one switch: Settings.inputMode
 * ('auto' | 'kbm' | 'gamepad'), toggled instantly with F9.
 */

export type Button =
  | 'fire' | 'ads' | 'sprint' | 'crouch' | 'jump' | 'reload' | 'interact'
  | 'swapWeapon' | 'throwable' | 'melee' | 'dodge' | 'heal' | 'swapShoulder'
  | 'freeLook' | 'inventory' | 'map' | 'pause' | 'toggleView';

export type Device = 'kbm' | 'gamepad';
export type PadStyle = 'xbox' | 'ps' | 'generic';

const BUTTONS: Button[] = [
  'fire', 'ads', 'sprint', 'crouch', 'jump', 'reload', 'interact',
  'swapWeapon', 'throwable', 'melee', 'dodge', 'heal', 'swapShoulder',
  'freeLook', 'inventory', 'map', 'pause', 'toggleView',
];

// ---- Keyboard + mouse bindings (KeyboardEvent.code / 'Mouse<n>' / 'Wheel') ----
export const KBM_BINDINGS: Record<Button, string[]> = {
  fire: ['Mouse0'],
  ads: ['Mouse2'],
  sprint: ['ShiftLeft'],
  crouch: ['KeyC'],
  jump: ['Space'],
  reload: ['KeyR'],
  interact: ['KeyF'],
  swapWeapon: ['Digit1', 'Digit2', 'Wheel'],
  throwable: ['KeyG'],
  melee: ['KeyV'],
  dodge: ['ControlLeft'],
  heal: ['KeyH'],
  swapShoulder: ['KeyQ', 'Mouse1'],
  freeLook: ['AltLeft'],
  inventory: ['Tab'],
  map: ['KeyM'],
  pause: ['KeyP'],
  toggleView: ['F5'],
};

// ---- Gamepad bindings (W3C "standard" mapping button indices) ----
// 0 A/✕  1 B/○  2 X/□  3 Y/△  4 LB  5 RB  6 LT  7 RT  8 View  9 Menu
// 10 L3  11 R3  12 D↑  13 D↓  14 D←  15 D→
const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

export const PAD_BINDINGS: Record<Button, number[]> = {
  fire: [PAD.RT],
  ads: [PAD.LT],
  sprint: [PAD.L3],
  crouch: [PAD.B],
  jump: [PAD.A],
  reload: [], // X tap (see tap/hold handling)
  interact: [], // X hold
  swapWeapon: [PAD.Y],
  throwable: [PAD.LB],
  melee: [PAD.R3],
  dodge: [PAD.RB],
  heal: [PAD.UP],
  swapShoulder: [PAD.RIGHT],
  freeLook: [PAD.LEFT],
  inventory: [PAD.DOWN],
  map: [PAD.VIEW],
  pause: [PAD.MENU],
  toggleView: [],
};

const X_HOLD_TIME = 0.3;
const TRIGGER_THRESHOLD = 0.35;
const MOUSE_RAD_PER_PX = 0.0022;
const PAD_LOOK_RAD_PER_SEC = 3.4;

interface ButtonState {
  down: boolean;
  pressed: boolean;
  released: boolean;
}

export class Input {
  /** Device currently driving gameplay. */
  activeDevice: Device = 'kbm';
  padStyle: PadStyle = 'generic';
  padConnected = false;
  pointerLocked = false;

  moveX = 0;
  moveY = 0;
  /** Look delta this frame, radians. */
  lookX = 0;
  lookY = 0;
  /** Analog trigger values 0..1 (keyboard reports 0/1). */
  fireAxis = 0;
  adsAxis = 0;

  private state = new Map<Button, ButtonState>();
  private keys = new Set<string>();
  private kbmPressedQueue = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  private padIndex: number | null = null;
  private padPrev: boolean[] = [];
  private xHeld = 0;
  private xHoldFired = false;

  constructor(private canvas: HTMLCanvasElement) {
    for (const b of BUTTONS) this.state.set(b, { down: false, pressed: false, released: false });
    this.bindDom();
    this.resolveDevice();
  }

  // ------------------------------------------------------------------ public API

  down(b: Button): boolean {
    return this.state.get(b)!.down;
  }
  pressed(b: Button): boolean {
    return this.state.get(b)!.pressed;
  }
  released(b: Button): boolean {
    return this.state.get(b)!.released;
  }

  get mode(): InputMode {
    return Settings.get('inputMode');
  }

  setMode(mode: InputMode): void {
    Settings.set('inputMode', mode);
    this.resolveDevice();
    Events.emit('input:mode', mode);
  }

  /** F9: auto → kbm → gamepad → auto. */
  cycleMode(): void {
    const order: InputMode[] = ['auto', 'kbm', 'gamepad'];
    this.setMode(order[(order.indexOf(this.mode) + 1) % order.length]);
  }

  requestPointerLock(): void {
    if (!this.pointerLocked) this.canvas.requestPointerLock?.();
  }

  rumble(strong: number, weak: number, ms: number): void {
    if (!Settings.get('rumble') || this.activeDevice !== 'gamepad' || this.padIndex === null) return;
    const pad = navigator.getGamepads()[this.padIndex];
    const act = (pad as any)?.vibrationActuator;
    act?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak }).catch?.(() => {});
  }

  /** Poll devices and build this frame's action state. Call once per render frame. */
  update(dt: number): void {
    const pad = this.pollPad();
    const padActivity = pad ? this.padHasActivity(pad) : false;
    const kbmActivity = this.keys.size > 0 || this.kbmPressedQueue.size > 0 || this.mouseDX !== 0 || this.mouseDY !== 0;

    if (this.mode === 'auto') {
      if (padActivity && this.activeDevice !== 'gamepad') this.setActiveDevice('gamepad');
      else if (kbmActivity && !padActivity && this.activeDevice !== 'kbm') this.setActiveDevice('kbm');
    }

    const useKbm = this.activeDevice === 'kbm';
    const usePad = this.activeDevice === 'gamepad' && pad !== null;

    // Buttons
    const nowDown = new Map<Button, boolean>();
    const edgePressed = new Set<Button>();
    for (const b of BUTTONS) nowDown.set(b, false);

    if (useKbm) {
      for (const b of BUTTONS) {
        for (const code of KBM_BINDINGS[b]) {
          if (this.keys.has(code)) nowDown.set(b, true);
          if (this.kbmPressedQueue.has(code)) edgePressed.add(b);
        }
      }
    }

    if (usePad) {
      const pressedNow = pad!.buttons.map((btn, i) =>
        i === PAD.LT || i === PAD.RT ? btn.value > TRIGGER_THRESHOLD : btn.pressed,
      );
      for (const b of BUTTONS) {
        for (const idx of PAD_BINDINGS[b]) if (pressedNow[idx]) nowDown.set(b, true);
      }
      // X: tap = reload, hold = interact
      const x = pressedNow[PAD.X];
      if (x) {
        this.xHeld += dt;
        if (this.xHeld >= X_HOLD_TIME) {
          nowDown.set('interact', true);
          if (!this.xHoldFired) {
            edgePressed.add('interact');
            this.xHoldFired = true;
          }
        }
      } else {
        if (this.padPrev[PAD.X] && !this.xHoldFired) edgePressed.add('reload');
        this.xHeld = 0;
        this.xHoldFired = false;
      }
      this.padPrev = pressedNow;
    }

    for (const b of BUTTONS) {
      const s = this.state.get(b)!;
      const d = nowDown.get(b)!;
      s.pressed = (d && !s.down) || edgePressed.has(b);
      s.released = !d && s.down;
      s.down = d;
    }

    // Axes
    this.moveX = this.moveY = this.lookX = this.lookY = 0;
    this.fireAxis = this.state.get('fire')!.down ? 1 : 0;
    this.adsAxis = this.state.get('ads')!.down ? 1 : 0;
    const invert = Settings.get('invertY') ? -1 : 1;

    if (useKbm) {
      this.moveX = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
      this.moveY = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
      const len = Math.hypot(this.moveX, this.moveY);
      if (len > 1) {
        this.moveX /= len;
        this.moveY /= len;
      }
      const sens = Settings.get('mouseSensitivity') * MOUSE_RAD_PER_PX;
      this.lookX = this.mouseDX * sens;
      this.lookY = this.mouseDY * sens * invert;
    }

    if (usePad) {
      const [mx, my] = this.stick(pad!.axes[0], pad!.axes[1]);
      this.moveX = mx;
      this.moveY = -my;
      const [lx, ly] = this.stick(pad!.axes[2], pad!.axes[3]);
      this.lookX = lx * PAD_LOOK_RAD_PER_SEC * Settings.get('gamepadSensitivityX') * dt;
      this.lookY = ly * PAD_LOOK_RAD_PER_SEC * Settings.get('gamepadSensitivityY') * dt * invert;
      this.fireAxis = pad!.buttons[PAD.RT]?.value ?? 0;
      this.adsAxis = pad!.buttons[PAD.LT]?.value ?? 0;
    }

    this.mouseDX = this.mouseDY = 0;
    this.kbmPressedQueue.clear();
  }

  // ------------------------------------------------------------------ internals

  private setActiveDevice(d: Device): void {
    if (this.activeDevice === d) return;
    this.activeDevice = d;
    Events.emit('input:device', d);
  }

  private resolveDevice(): void {
    if (this.mode === 'kbm') this.setActiveDevice('kbm');
    else if (this.mode === 'gamepad') this.setActiveDevice('gamepad');
    else if (!this.padConnected) this.setActiveDevice('kbm');
  }

  /** Radial deadzone + response curve. */
  private stick(x: number, y: number): [number, number] {
    const dz = Settings.get('stickDeadzone');
    const mag = Math.hypot(x, y);
    if (mag < dz) return [0, 0];
    const norm = Math.min((mag - dz) / (1 - dz), 1);
    const curved = Math.pow(norm, Settings.get('stickCurve'));
    return [(x / mag) * curved, (y / mag) * curved];
  }

  private pollPad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    if (this.padIndex !== null && pads[this.padIndex]) return pads[this.padIndex];
    for (const p of pads) {
      if (p && p.connected) {
        this.padIndex = p.index;
        if (!this.padConnected) {
          this.padConnected = true;
          this.padStyle = detectPadStyle(p.id);
          Events.emit('input:pad', { connected: true, id: p.id, style: this.padStyle });
        }
        return p;
      }
    }
    return null;
  }

  private padHasActivity(pad: Gamepad): boolean {
    const dz = Settings.get('stickDeadzone') + 0.1;
    if (pad.axes.some((a) => Math.abs(a) > dz)) return true;
    return pad.buttons.some((b) => b.pressed || b.value > TRIGGER_THRESHOLD);
  }

  private kbmAllowed(): boolean {
    return this.mode !== 'gamepad';
  }

  private bindDom(): void {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F9') {
        e.preventDefault();
        this.cycleMode();
        return;
      }
      if (['Tab', 'F5', 'AltLeft', 'Space'].includes(e.code)) e.preventDefault();
      if (!this.kbmAllowed() || e.repeat) return;
      this.keys.add(e.code);
      this.kbmPressedQueue.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.kbmAllowed() || !this.pointerLocked) return;
      const code = `Mouse${e.button}`;
      this.keys.add(code);
      this.kbmPressedQueue.add(code);
    });
    window.addEventListener('mouseup', (e) => this.keys.delete(`Mouse${e.button}`));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked || !this.kbmAllowed()) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (!this.pointerLocked || !this.kbmAllowed()) return;
        if (Math.abs(e.deltaY) > 0) this.kbmPressedQueue.add('Wheel');
      },
      { passive: true },
    );

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) this.keys.clear();
      Events.emit('input:pointerlock', this.pointerLocked);
    });

    window.addEventListener('gamepadconnected', (e) => {
      this.padIndex = e.gamepad.index;
      this.padConnected = true;
      this.padStyle = detectPadStyle(e.gamepad.id);
      Events.emit('input:pad', { connected: true, id: e.gamepad.id, style: this.padStyle });
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.padIndex === e.gamepad.index) this.padIndex = null;
      this.padConnected = navigator.getGamepads().some((p) => p?.connected);
      Events.emit('input:pad', { connected: this.padConnected });
      if (this.mode === 'auto') this.setActiveDevice('kbm');
    });
  }
}

export function detectPadStyle(id: string): PadStyle {
  if (/playstation|dualsense|dualshock|054c/i.test(id)) return 'ps';
  if (/xbox|xinput|045e/i.test(id)) return 'xbox';
  return 'generic';
}
