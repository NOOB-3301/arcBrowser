import type { Button, Device, PadStyle } from '../core/Input';
import { KBM_BINDINGS } from '../core/Input';

const PAD_GLYPHS: Record<PadStyle, Record<Button, string>> = {
  xbox: {
    fire: 'RT', ads: 'LT', sprint: 'LS', crouch: 'B', jump: 'A', reload: 'X', interact: 'Hold X',
    swapWeapon: 'Y', throwable: 'LB', melee: 'RS', dodge: 'RB', heal: 'D↑', swapShoulder: 'D→',
    freeLook: 'D←', inventory: 'D↓', map: 'View', pause: 'Menu', toggleView: '—',
  },
  ps: {
    fire: 'R2', ads: 'L2', sprint: 'L3', crouch: '○', jump: '✕', reload: '□', interact: 'Hold □',
    swapWeapon: '△', throwable: 'L1', melee: 'R3', dodge: 'R1', heal: 'D↑', swapShoulder: 'D→',
    freeLook: 'D←', inventory: 'D↓', map: 'Share', pause: 'Options', toggleView: '—',
  },
  generic: {
    fire: 'R2', ads: 'L2', sprint: 'L3', crouch: 'B2', jump: 'B1', reload: 'B3', interact: 'Hold B3',
    swapWeapon: 'B4', throwable: 'L1', melee: 'R3', dodge: 'R1', heal: 'D↑', swapShoulder: 'D→',
    freeLook: 'D←', inventory: 'D↓', map: 'Select', pause: 'Start', toggleView: '—',
  },
};

function keyLabel(code: string): string {
  if (code === 'Mouse0') return 'LMB';
  if (code === 'Mouse1') return 'MMB';
  if (code === 'Mouse2') return 'RMB';
  if (code === 'Wheel') return 'Wheel';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code.replace('Left', '').replace('Control', 'Ctrl');
}

/** Human-readable prompt for an action on the active device. */
export function glyph(button: Button, device: Device, style: PadStyle): string {
  if (device === 'gamepad') return PAD_GLYPHS[style][button];
  return keyLabel(KBM_BINDINGS[button][0]);
}
