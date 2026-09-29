# Credits

## Textures
All textures in `public/assets/textures/` are from [Poly Haven](https://polyhaven.com) and licensed CC0:
aerial_grass_rock, forrest_ground_01, rock_face, coast_sand_01, asphalt_02,
concrete_floor_worn_001, rusty_metal_02, corrugated_iron,
concrete_wall_008, plastered_wall_02, red_brick_03.

## PBR texture sets (W1)
`public/assets/textures/pbr/*.ktx2` are packed from Poly Haven (CC0) 2k maps (diffuse, normal GL, ARM, displacement) of the same materials:
 albedo+height as ETC1S KTX2 (2k), normal/roughness/AO as UASTC KTX2 (1k).
`public/assets/basis/` is the Basis Universal transcoder shipped with three.js (Apache-2.0).

## Libraries (W1)
- [n8ao](https://github.com/N8python/n8ao) (ISC) ambient occlusion; `postprocessing` (Zlib) is its peer dependency.

## Models (`public/assets/models/`)
The in-game list lives in `src/assets/credits.ts`.

| Asset | Source | Author | License | Notes |
|---|---|---|---|---|
| raider.glb (mesh, textures) | [Sci-Fi Soldier / Futuristic Combat Trooper](https://sketchfab.com/3d-models/de876bfdce1c47a4aa67670faee7208e) | evgenytvidov | CC-BY 4.0 | Re-skinned to the UAL skeleton, decimated to 27.7k tris, 1k webp textures |
| raider.glb (skeleton, animations) | [Universal Animation Library 1 & 2](https://quaternius.itch.io/universal-animation-library) | Quaternius | CC0 1.0 | Rifle_Aim, Rifle_Idle, Rifle_Reload and Ladder_Climb_Loop authored for RUSTFALL |
| weapons.glb (13 weapons) | Original, modelled in Blender for RUSTFALL | RUSTFALL (W2) | CC0 1.0 | Textures: Poly Haven [green_metal_rust](https://polyhaven.com/a/green_metal_rust), [metal_plate_02](https://polyhaven.com/a/metal_plate_02) by Rob Tuytel (CC0), desaturated + tinted |
| arc_tick/wasp/sentinel/stalker/colossus.glb | Original, modelled in Blender for RUSTFALL | RUSTFALL (W2) | CC0 1.0 | Same Poly Haven CC0 textures as weapons.glb |

## Audio (W6) — `public/assets/audio/`
All sound files are **CC0 1.0** (public domain dedication); crediting is voluntary. They were
trimmed, onset-aligned, normalised, made mono and re-encoded to Opus/WebM (loops crossfaded) for
RUSTFALL. Music is generated at runtime (no assets); every sample group also has a procedural
synthesis fallback in `src/audio/`.

| Files | Source | Author | License |
|---|---|---|---|
| step_*, land_*, thud_*, flesh_*, imp_*, brass_*, arc_skitter/stomp/debris_* | [Impact Sounds](https://kenney.nl/assets/impact-sounds) | Kenney | CC0 1.0 |
| gun_energy*, expl_near/low_*, emp_0, hiss_0, arc_servo/rotor/engine_big/charge_1/beep_0/laser_* | [Sci-fi Sounds](https://kenney.nl/assets/sci-fi-sounds) | Kenney | CC0 1.0 |
| ui_confirm/error/back/open/close, loot_drop_0, beep_1, tick_0 | [Interface Sounds](https://kenney.nl/assets/interface-sounds) | Kenney | CC0 1.0 |
| ui_click_*, ui_hover_* | [UI Audio](https://kenney.nl/assets/ui-audio) | Kenney | CC0 1.0 |
| emp_1, arc_charge_0, beep_0 | [Digital Audio](https://kenney.nl/assets/digital-audio) | Kenney | CC0 1.0 |
| cloth_*, handle_*, belt_0, mech_click/latch, loot_pick_*, box_open, rummage_*, pin_0, step_dirt_* | [RPG Audio](https://kenney.nl/assets/rpg-audio) | Kenney | CC0 1.0 |
| gun_rifle_*, gun_heavy_*, gun_shotgun_0, gun_pistol_4, gun_tail_* | [Gunshot Sounds](https://opengameart.org/content/gunshot-sounds) (sks, mosin, shotty, cz) | tabasco | CC0 1.0 |
| gun_pistol_0-3, gun_revolver_*, gun_crack_*, gun_shotgun_1-2 | [Gunshots](https://opengameart.org/content/gunshots) (.22 pistol, .22 magnum, black powder, unknown) | Kurt | CC0 1.0 |
| reload_magout/magin/bolt/slide/pump | [Gun Reload Sounds](https://opengameart.org/content/gun-reload-sounds) | springyspringo | CC0 1.0 |
| reload_misc_* | [2 Gun Reloads](https://opengameart.org/content/2-gun-reloads) | StarNinjas | CC0 1.0 |
| expl_far_0 | [Muffled Distant Explosion](https://opengameart.org/content/muffled-distant-explosion) | NenadSimic | CC0 1.0 |
| expl_big_0, arc_rocket_0, arc_beep_1-2 | [50 CC0 Sci-Fi SFX](https://opengameart.org/content/50-cc0-sci-fi-sfx) | rubberduck | CC0 1.0 |
| box_open_1 | [100 CC0 SFX](https://opengameart.org/content/100-cc0-sfx) | rubberduck | CC0 1.0 |
| alarm_0 | [30 CC0 SFX Loops](https://opengameart.org/content/30-cc0-sfx-loops) | rubberduck | CC0 1.0 |
| amb_rain | [Amb Rain Loop 1](https://opengameart.org/content/amb-rain-loop-1) | Kresiek the furry | CC0 1.0 |
| thunder_0 | [Rain (long) + Thunder](https://opengameart.org/content/rain-long-thunder) | wuxiascrub | CC0 1.0 |
| amb_wind | [Park Ambiences](https://opengameart.org/content/park-ambiences) (wind) | thimras | CC0 1.0 |
| amb_birds | [Ambient Bird Sounds](https://opengameart.org/content/ambient-bird-sounds) | isaiah658 | CC0 1.0 |
| amb_crickets | [Crickets Ambient Noise (loopable)](https://opengameart.org/content/crickets-ambient-noise-loopable) | wolfgang | CC0 1.0 |
| heartbeat | [Heartbeat Sounds](https://opengameart.org/content/heartbeat-sounds) | bart | CC0 1.0 |
