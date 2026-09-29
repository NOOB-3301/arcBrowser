/** Third-party asset credits, for the in-game credits screen. Keep in sync with CREDITS.md. */
export interface Credit {
  asset: string;
  title: string;
  author: string;
  url: string;
  license: 'CC0 1.0' | 'CC-BY 4.0' | 'CC-BY 3.0' | 'Original';
  notes?: string;
}

export const CREDITS: Credit[] = [
  {
    asset: 'raider.glb (mesh + textures)',
    title: 'Sci-Fi Soldier / Futuristic Combat Trooper',
    author: 'evgenytvidov',
    url: 'https://sketchfab.com/3d-models/de876bfdce1c47a4aa67670faee7208e',
    license: 'CC-BY 4.0',
    notes: 'Re-skinned to the UAL skeleton, decimated, textures resized to 1k webp.',
  },
  {
    asset: 'raider.glb (skeleton + animations)',
    title: 'Universal Animation Library 1 & 2 (Standard)',
    author: 'Quaternius',
    url: 'https://quaternius.itch.io/universal-animation-library',
    license: 'CC0 1.0',
    notes: 'Rifle aim/idle/reload and ladder-climb clips authored for RUSTFALL on the same skeleton.',
  },
  {
    asset: 'weapons.glb',
    title: 'RUSTFALL weapon set (13 models)',
    author: 'RUSTFALL',
    url: 'https://polyhaven.com/a/green_metal_rust',
    license: 'Original',
    notes: 'Modelled in Blender; surface textures green_metal_rust + metal_plate_02 by Rob Tuytel (Poly Haven, CC0).',
  },
  {
    asset: 'textures/*',
    title: 'Poly Haven textures',
    author: 'Poly Haven',
    url: 'https://polyhaven.com',
    license: 'CC0 1.0',
  },
  // W6: audio (all CC0; see CREDITS.md for the per-file table)
  { asset: 'audio: footsteps, impacts, UI, sci-fi, foley', title: 'Impact / Sci-fi / Interface / UI / Digital / RPG Audio', author: 'Kenney', url: 'https://kenney.nl/assets?t=audio', license: 'CC0 1.0' },
  { asset: 'audio: rifle / heavy / shotgun shots + tails', title: 'Gunshot Sounds', author: 'tabasco', url: 'https://opengameart.org/content/gunshot-sounds', license: 'CC0 1.0' },
  { asset: 'audio: pistol / revolver shots', title: 'Gunshots', author: 'Kurt', url: 'https://opengameart.org/content/gunshots', license: 'CC0 1.0' },
  { asset: 'audio: reloads', title: 'Gun Reload Sounds / 2 Gun Reloads', author: 'springyspringo, StarNinjas', url: 'https://opengameart.org/content/gun-reload-sounds', license: 'CC0 1.0' },
  { asset: 'audio: distant explosion', title: 'Muffled Distant Explosion', author: 'NenadSimic', url: 'https://opengameart.org/content/muffled-distant-explosion', license: 'CC0 1.0' },
  { asset: 'audio: explosion, rocket, beeps, alarm, crate', title: '50 CC0 Sci-Fi SFX / 100 CC0 SFX / 30 CC0 SFX Loops', author: 'rubberduck', url: 'https://opengameart.org/users/rubberduck', license: 'CC0 1.0' },
  { asset: 'audio: rain loop', title: 'Amb Rain Loop 1', author: 'Kresiek the furry', url: 'https://opengameart.org/content/amb-rain-loop-1', license: 'CC0 1.0' },
  { asset: 'audio: thunder', title: 'Rain (long) + Thunder', author: 'wuxiascrub', url: 'https://opengameart.org/content/rain-long-thunder', license: 'CC0 1.0' },
  { asset: 'audio: wind bed', title: 'Park Ambiences', author: 'thimras', url: 'https://opengameart.org/content/park-ambiences', license: 'CC0 1.0' },
  { asset: 'audio: birds', title: 'Ambient Bird Sounds', author: 'isaiah658', url: 'https://opengameart.org/content/ambient-bird-sounds', license: 'CC0 1.0' },
  { asset: 'audio: crickets', title: 'Crickets Ambient Noise (loopable)', author: 'wolfgang', url: 'https://opengameart.org/content/crickets-ambient-noise-loopable', license: 'CC0 1.0' },
  { asset: 'audio: heartbeat', title: 'Heartbeat Sounds', author: 'bart', url: 'https://opengameart.org/content/heartbeat-sounds', license: 'CC0 1.0' },
];
