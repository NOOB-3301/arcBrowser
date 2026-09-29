import type { Button, Device, PadBind, PadStyle } from '../core/Input';
import { KBM_BINDINGS, PAD_BINDINGS } from '../core/Input';

// W5: glyphs are derived from the live (rebindable) bindings.

/** Button names per pad family, indexed by W3C standard-mapping button index. */
const PAD_NAMES: Record<PadStyle, string[]> = {
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'D↑', 'D↓', 'D←', 'D→', 'Guide'],
  ps: ['✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', 'D↑', 'D↓', 'D←', 'D→', 'PS'],
  generic: ['B1', 'B2', 'B3', 'B4', 'L1', 'R1', 'L2', 'R2', 'Select', 'Start', 'L3', 'R3', 'D↑', 'D↓', 'D←', 'D→', 'Home'],
};

const KEY_NAMES: Record<string, string> = {
  Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5', Wheel: 'Wheel',
  Control: 'Ctrl', ControlLeft: 'LCtrl', ControlRight: 'RCtrl', ShiftLeft: 'Shift', ShiftRight: 'RShift',
  AltLeft: 'Alt', AltRight: 'RAlt', MetaLeft: 'Cmd', MetaRight: 'RCmd', Space: 'Space', Tab: 'Tab',
  Enter: 'Enter', Backspace: 'Bksp', CapsLock: 'Caps', Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',',
  Period: '.', Slash: '/', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Insert: 'Ins', Delete: 'Del', PageUp: 'PgUp', PageDown: 'PgDn',
};

/** Short label for a keyboard / mouse binding code. */
export function keyLabel(code: string): string {
  if (!code) return '—';
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Mouse')) return `Mouse ${Number(code.slice(5)) + 1}`;
  return code;
}

export function padButtonName(btn: number, style: PadStyle): string {
  return PAD_NAMES[style][btn] ?? `B${btn}`;
}

/** Label for a pad binding ("Hold X", "RT"…). */
export function padLabel(bind: PadBind | null | undefined, style: PadStyle): string {
  if (!bind) return '—';
  const name = padButtonName(bind.btn, style);
  return bind.mode === 'hold' ? `Hold ${name}` : name;
}

/** Human-readable prompt for an action on the active device. */
export function glyph(button: Button, device: Device, style: PadStyle): string {
  if (device === 'gamepad') return padLabel(PAD_BINDINGS[button][0], style);
  return keyLabel(KBM_BINDINGS[button].find((c) => c) ?? '');
}

/** All keyboard bindings for an action ("Ctrl / Z"). */
export function kbmGlyphs(codes: string[]): string {
  const set = codes.filter((c) => c);
  return set.length ? set.map(keyLabel).join(' / ') : '—';
}
