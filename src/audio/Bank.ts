/**
 * W6a — sample bank. Every file lives in public/assets/audio/<name>.webm (mono Opus).
 * Names ending in _<n> are variants of the group before the suffix ("gun_rifle_2" → "gun_rifle");
 * the engine picks a random variant per play and avoids immediate repeats.
 * Sources + licences: CREDITS.md (all CC0).
 */
export const SAMPLE_FILES: readonly string[] = [
  // weapons
  'gun_pistol_0', 'gun_pistol_1', 'gun_pistol_2', 'gun_pistol_3', 'gun_pistol_4',
  'gun_revolver_0', 'gun_revolver_1', 'gun_revolver_2',
  'gun_rifle_0', 'gun_rifle_1', 'gun_rifle_2', 'gun_rifle_3',
  'gun_heavy_0', 'gun_heavy_1', 'gun_heavy_2',
  'gun_crack_0', 'gun_crack_1', 'gun_crack_2',
  'gun_shotgun_0', 'gun_shotgun_1', 'gun_shotgun_2',
  'gun_tail_0', 'gun_tail_1', 'gun_tail_2',
  'gun_energy_0', 'gun_energy_1', 'gun_energy_2',
  'gun_energy_small_0', 'gun_energy_small_1', 'gun_energy_small_2',
  'mech_click', 'mech_latch',
  'reload_magout', 'reload_magin', 'reload_bolt', 'reload_slide', 'reload_pump', 'reload_misc_1', 'reload_misc_2',
  'cloth_1', 'cloth_2', 'cloth_3', 'cloth_4', 'handle_0', 'handle_1', 'belt_0',
  'brass_0', 'brass_1', 'brass_2',
  // footsteps / body
  ...['grass', 'concrete', 'wood', 'metal', 'dirt'].flatMap((s) => [0, 1, 2, 3, 4].map((i) => `step_${s}_${i}`)),
  'land_0', 'land_1', 'land_2', 'thud_0', 'thud_1', 'thud_2', 'flesh_0', 'flesh_1', 'flesh_2',
  // impacts
  ...['imp_dirt', 'imp_concrete', 'imp_metal', 'imp_metal_med', 'imp_metal_heavy', 'imp_glass', 'imp_plate_heavy', 'imp_wood'].flatMap((s) => [0, 1, 2].map((i) => `${s}_${i}`)),
  // explosions / throwables
  'expl_near_0', 'expl_near_1', 'expl_near_2', 'expl_near_3', 'expl_low_0', 'expl_low_1', 'expl_far_0', 'expl_big_0',
  'emp_0', 'emp_1', 'hiss_0', 'pin_0',
  // ARC
  'arc_servo_0', 'arc_servo_1', 'arc_servo_2', 'arc_rotor', 'arc_engine_big', 'arc_charge_0', 'arc_charge_1',
  'arc_beep_0', 'arc_beep_1', 'arc_beep_2', 'arc_laser_0', 'arc_laser_1', 'arc_rocket_0',
  'arc_skitter_0', 'arc_skitter_1', 'arc_skitter_2', 'arc_stomp_0', 'arc_stomp_1', 'arc_stomp_2', 'arc_debris_0', 'arc_debris_1',
  // UI / loot / raid
  'ui_click_1', 'ui_click_2', 'ui_click_3', 'ui_hover_1', 'ui_hover_2', 'ui_hover_3',
  'ui_confirm', 'ui_error', 'ui_back', 'ui_open', 'ui_close',
  'loot_pick_0', 'loot_pick_1', 'loot_drop_0', 'box_open', 'box_open_1', 'rummage_1', 'rummage_2', 'rummage_3',
  'alarm_0', 'beep_0', 'beep_1', 'tick_0', 'heartbeat',
  // ambience
  'amb_wind', 'amb_birds', 'amb_crickets', 'amb_rain', 'thunder_0',
];

/** Group name for a file ("gun_rifle_2" → "gun_rifle", "heartbeat" → "heartbeat"). */
export function groupOf(file: string): string {
  const m = /^(.*)_\d+$/.exec(file);
  return m ? m[1] : file;
}

const base = import.meta.env.BASE_URL;
export const sampleUrl = (file: string): string => `${base}assets/audio/${file}.webm`;
