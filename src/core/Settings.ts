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
}

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
  showDebug: true,
};

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

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // ignore
    }
  },
};
