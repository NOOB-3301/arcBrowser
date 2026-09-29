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
];
