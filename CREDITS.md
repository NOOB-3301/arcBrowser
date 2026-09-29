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
