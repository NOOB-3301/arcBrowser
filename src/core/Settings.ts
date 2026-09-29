import { Events } from './Events';

export type InputMode = 'auto' | 'kbm' | 'gamepad';

export interface SettingsData {
  inputMode: InputMode;
  mouseSensitivity: number;
  gamepadSensitivityX: number;
  gamepadSensitivityY: number;
  adsSensitivityMultiplier: number;
  invertY: boolean;
  fov: number;
  stickDeadzone: number;
  stickCurve: number;
  aimAssist: number;
  rumble: boolean;
  showDebug: boolean;
  difficulty: 'recruit' | 'veteran' | 'elite' | 'nightmare';
  graphicsQuality: 'low' | 'medium' | 'high' | 'ultra';
  // W5: settings menu
  /** Adaptive render resolution under load (PostFX). */
  dynamicRes: boolean;
  /** stats-gl FPS panel. */
  showFps: boolean;
  /** Camera shake multiplier (0 = off). */
  cameraShake: number;
  /** Aim assist strength remembered while the toggle is off (aimAssist itself is 0 when off). */
  aimAssistStrength: number;
  /** Audio mix 0..1 (read by the audio system via Settings.get). */
  volMaster: number;
  volSfx: number;
  volMusic: number;
  volUi: number;
  /** Colour-blind safe HUD marker palette. */
  colorblind: ColorblindMode;
  /** Crosshair colour (CSS colour). */
  crosshairColor: string;
}

export type ColorblindMode = 'off' | 'deuter' | 'prot' | 'trit';

const STORAGE_KEY = 'rustfall.settings.v1';

const DEFAULTS: SettingsData = {
  inputMode: 'auto',
  mouseSensitivity: 1,
  gamepadSensitivityX: 1,
  gamepadSensitivityY: 0.8,
  adsSensitivityMultiplier: 0.6,
  invertY: false,
  fov: 75,
  stickDeadzone: 0.15,
  stickCurve: 1.8,
  aimAssist: 0.5,
  rumble: true,
  showDebug: false,
  difficulty: 'veteran',
  graphicsQuality: 'high',
  // W5
  dynamicRes: true,
  showFps: true,
  cameraShake: 1,
  aimAssistStrength: 0.5,
  volMaster: 0.8,
  volSfx: 1,
  volMusic: 0.6,
  volUi: 0.8,
  colorblind: 'off',
  crosshairColor: '#f1ead8',
};

export const SETTINGS_DEFAULTS: Readonly<SettingsData> = DEFAULTS;

function load(): SettingsData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // storage blocked or corrupt; fall back to defaults
  }
  return { ...DEFAULTS };
}

export const Settings = {
  data: load(),

  get<K extends keyof SettingsData>(key: K): SettingsData[K] {
    return this.data[key];
  },

  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]): void {
    this.data[key] = value;
    this.save();
    Events.emit('settings:changed', { key, value });
  },

  /** W5: restore the given keys (or everything) to defaults, notifying listeners per key. */
  reset(keys?: (keyof SettingsData)[]): void {
    for (const k of keys ?? (Object.keys(DEFAULTS) as (keyof SettingsData)[])) this.set(k, DEFAULTS[k] as never);
  },

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // ignore
    }
  },
};
