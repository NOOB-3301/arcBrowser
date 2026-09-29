import type { IconId } from './Items';

/**
 * Inline SVG item icons. Drawn in a 64×32 (wide) or 32×32 box with currentColor,
 * so the UI tints them by rarity. Weapons use the wide box.
 */

const WIDE = new Set<IconId>(['pistol', 'smg', 'rifle', 'shotgun', 'sniper', 'lmg', 'energy', 'camera', 'relay']);

const P: Record<IconId, string> = {
  // ---- weapons (64×32)
  pistol: `<path d="M18 9h30v6H34l-2 3h-6l-3 9h-7l3-12h-1z" fill="currentColor"/><rect x="46" y="10" width="4" height="3" fill="currentColor" opacity=".6"/>`,
  smg: `<path d="M8 11h40v5H36l-1 4h-5l-2 7h-6l2-7h-4l-4 5H9l4-7H8z" fill="currentColor"/><rect x="48" y="12" width="8" height="2" fill="currentColor"/><rect x="30" y="16" width="3" height="10" fill="currentColor" opacity=".7"/>`,
  rifle: `<path d="M3 13l10-2h34v5H38l-2 3h-5l-3 8h-6l2-8h-4l-4 3H4z" fill="currentColor"/><rect x="47" y="12" width="14" height="2" fill="currentColor"/><rect x="26" y="7" width="12" height="3" fill="currentColor" opacity=".7"/>`,
  shotgun: `<path d="M3 14l11-3h28v5H30l-3 3h-6l-4 7h-6l3-7H4z" fill="currentColor"/><rect x="42" y="11" width="19" height="2" fill="currentColor"/><rect x="38" y="15" width="16" height="3" rx="1" fill="currentColor" opacity=".7"/>`,
  sniper: `<path d="M2 14l11-3h30v4H34l-2 3h-5l-3 8h-6l2-8H6z" fill="currentColor"/><rect x="43" y="12" width="19" height="2" fill="currentColor"/><rect x="22" y="5" width="16" height="4" rx="2" fill="currentColor" opacity=".8"/><rect x="28" y="9" width="3" height="3" fill="currentColor"/>`,
  lmg: `<path d="M2 13l11-3h34v6H37l-2 3h-6l-3 8h-6l2-8H4z" fill="currentColor"/><rect x="47" y="11" width="15" height="3" fill="currentColor"/><rect x="24" y="17" width="10" height="9" rx="2" fill="currentColor" opacity=".7"/><path d="M52 14l-3 10M56 14l3 10" stroke="currentColor" stroke-width="2"/>`,
  energy: `<path d="M4 13l10-4h30l6 3v4l-6 3H33l-3 8h-6l2-8h-6l-4 3H5z" fill="currentColor"/><path d="M50 13h11M54 10l4 3-4 3" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="30" cy="13" r="3" fill="#000" opacity=".4"/>`,
  // ---- square (32×32)
  ammo: `<g fill="currentColor"><path d="M7 12l2-5 2 5v14H7z"/><path d="M14 10l2-5 2 5v16h-4z"/><path d="M21 12l2-5 2 5v14h-4z"/></g><rect x="5" y="23" width="22" height="3" fill="currentColor" opacity=".55"/>`,
  shells: `<g fill="currentColor"><rect x="6" y="9" width="6" height="15" rx="1"/><rect x="13" y="9" width="6" height="15" rx="1"/><rect x="20" y="9" width="6" height="15" rx="1"/></g><rect x="5" y="21" width="22" height="4" fill="currentColor" opacity=".55"/>`,
  cells: `<rect x="9" y="6" width="14" height="21" rx="2" fill="none" stroke="currentColor" stroke-width="2.5"/><rect x="13" y="3" width="6" height="3" fill="currentColor"/><path d="M17 10l-4 7h4l-2 6 5-8h-4z" fill="currentColor"/>`,
  bandage: `<rect x="5" y="10" width="22" height="12" rx="6" fill="none" stroke="currentColor" stroke-width="2.5" transform="rotate(-30 16 16)"/><path d="M16 11v10M11 16h10" stroke="currentColor" stroke-width="3"/>`,
  medkit: `<rect x="4" y="9" width="24" height="17" rx="2" fill="currentColor" opacity=".25" stroke="currentColor" stroke-width="2"/><rect x="12" y="5" width="8" height="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 12v11M10.5 17.5h11" stroke="currentColor" stroke-width="3.5"/>`,
  shieldcell: `<path d="M16 3l11 6v14l-11 6-11-6V9z" fill="currentColor" opacity=".25" stroke="currentColor" stroke-width="2"/><path d="M17 8l-6 9h5l-2 7 7-10h-5z" fill="currentColor"/>`,
  shield: `<path d="M16 3l11 4v8c0 7-5 12-11 14C10 27 5 22 5 15V7z" fill="currentColor" opacity=".3" stroke="currentColor" stroke-width="2.5"/><path d="M16 8v17" stroke="currentColor" stroke-width="2"/>`,
  frag: `<circle cx="16" cy="19" r="9" fill="currentColor" opacity=".35" stroke="currentColor" stroke-width="2"/><rect x="13" y="6" width="6" height="5" fill="currentColor"/><path d="M19 7l6-3" stroke="currentColor" stroke-width="2"/><path d="M8 19h16M16 11v16" stroke="currentColor" stroke-width="1.2" opacity=".7"/>`,
  emp: `<rect x="8" y="8" width="16" height="18" rx="3" fill="currentColor" opacity=".3" stroke="currentColor" stroke-width="2"/><path d="M17 11l-5 7h4l-2 6 6-8h-4z" fill="currentColor"/><path d="M4 12a14 14 0 000 10M28 12a14 14 0 010 10" stroke="currentColor" stroke-width="2" fill="none"/>`,
  smoke: `<rect x="10" y="12" width="12" height="16" rx="2" fill="currentColor" opacity=".35" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="7" r="3.5" fill="currentColor" opacity=".6"/><circle cx="19" cy="5" r="4" fill="currentColor" opacity=".45"/><circle cx="24" cy="9" r="3" fill="currentColor" opacity=".35"/>`,
  decoy: `<rect x="9" y="10" width="14" height="17" rx="3" fill="currentColor" opacity=".3" stroke="currentColor" stroke-width="2"/><path d="M13 16l3-2v8l-3-2zM18 14a4 4 0 010 6" stroke="currentColor" stroke-width="2" fill="none"/><path d="M16 10V5" stroke="currentColor" stroke-width="2"/>`,
  mine: `<ellipse cx="16" cy="20" rx="12" ry="6" fill="currentColor" opacity=".35" stroke="currentColor" stroke-width="2"/><rect x="12" y="11" width="8" height="6" fill="currentColor"/><circle cx="16" cy="9" r="2" fill="#ff4b3a"/>`,
  key: `<circle cx="10" cy="16" r="6" fill="none" stroke="currentColor" stroke-width="3"/><path d="M16 16h13M24 16v5M28 16v4" stroke="currentColor" stroke-width="3"/>`,
  keycard: `<rect x="4" y="8" width="24" height="16" rx="2" fill="currentColor" opacity=".3" stroke="currentColor" stroke-width="2"/><rect x="7" y="12" width="7" height="6" fill="currentColor"/><path d="M17 13h8M17 17h6" stroke="currentColor" stroke-width="2"/>`,
  scrap: `<path d="M5 22l6-12 7 4 9-6-3 16-10 3z" fill="currentColor" opacity=".35" stroke="currentColor" stroke-width="2"/><circle cx="13" cy="19" r="2" fill="currentColor"/>`,
  fabric: `<path d="M5 9c5-3 9 3 14 0s7-2 8 0v14c-1-2-3-3-8 0s-9-3-14 0z" fill="currentColor" opacity=".35" stroke="currentColor" stroke-width="2"/>`,
  chem: `<path d="M12 4h8M13 4v8l-7 13a2 2 0 002 3h16a2 2 0 002-3l-7-13V4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 21h14l2 4H7z" fill="currentColor"/>`,
  chip: `<rect x="8" y="8" width="16" height="16" rx="2" fill="currentColor" opacity=".35" stroke="currentColor" stroke-width="2"/><path d="M12 4v4M16 4v4M20 4v4M12 24v4M16 24v4M20 24v4M4 12h4M4 16h4M4 20h4M24 12h4M24 16h4M24 20h4" stroke="currentColor" stroke-width="2"/>`,
  battery: `<rect x="5" y="10" width="20" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2.5"/><rect x="25" y="13" width="3" height="6" fill="currentColor"/><rect x="8" y="13" width="10" height="6" fill="currentColor"/>`,
  alloy: `<path d="M3 22l5-10h16l5 10z" fill="currentColor" opacity=".45" stroke="currentColor" stroke-width="2"/><path d="M9 12l3-5h8l3 5" fill="none" stroke="currentColor" stroke-width="2"/>`,
  core: `<circle cx="16" cy="16" r="11" fill="currentColor" opacity=".2" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="16" r="5" fill="currentColor"/><path d="M16 3v6M16 23v6M3 16h6M23 16h6" stroke="currentColor" stroke-width="2"/>`,
  optic: `<path d="M3 16c4-7 9-10 13-10s9 3 13 10c-4 7-9 10-13 10S7 23 3 16z" fill="currentColor" opacity=".25" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="16" r="5" fill="currentColor"/><circle cx="14" cy="14" r="1.5" fill="#fff"/>`,
  servo: `<circle cx="16" cy="16" r="9" fill="none" stroke="currentColor" stroke-width="4" stroke-dasharray="4 3"/><circle cx="16" cy="16" r="4" fill="currentColor"/>`,
  watch: `<circle cx="16" cy="18" r="9" fill="currentColor" opacity=".25" stroke="currentColor" stroke-width="2.5"/><path d="M16 18v-5M16 18l4 2" stroke="currentColor" stroke-width="2"/><rect x="14" y="4" width="4" height="5" fill="currentColor"/>`,
  drive: `<rect x="7" y="4" width="18" height="24" rx="2" fill="currentColor" opacity=".3" stroke="currentColor" stroke-width="2"/><rect x="11" y="8" width="10" height="7" fill="currentColor"/><path d="M11 22h10" stroke="currentColor" stroke-width="2"/>`,
  camera: `<rect x="10" y="9" width="44" height="18" rx="3" fill="currentColor" opacity=".3" stroke="currentColor" stroke-width="2"/><circle cx="32" cy="18" r="6" fill="none" stroke="currentColor" stroke-width="3"/><rect x="14" y="5" width="9" height="4" fill="currentColor"/>`,
  relay: `<rect x="8" y="7" width="48" height="18" rx="2" fill="currentColor" opacity=".25" stroke="currentColor" stroke-width="2"/><path d="M14 12h10v8H14zM30 12h6v8h-6zM42 12h8v8h-8z" fill="currentColor"/>`,
  idol: `<path d="M16 3a5 5 0 110 10 5 5 0 010-10zM9 14h14l-2 9h3v5H8v-5h3z" fill="currentColor" opacity=".45" stroke="currentColor" stroke-width="2"/>`,
};

export function iconSvg(id: IconId): string {
  const wide = WIDE.has(id);
  const vb = wide ? '0 0 64 32' : '0 0 32 32';
  return `<svg class="ico" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${P[id]}</svg>`;
}
