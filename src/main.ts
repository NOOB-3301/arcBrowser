import { Game } from './core/Game';
import { Events } from './core/Events';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const mapId = new URLSearchParams(location.search).get('map') ?? 'ironvale';

const loading = document.createElement('div');
loading.className = 'loading';
loading.innerHTML = '<h1>RUSTFALL</h1><p>Loading…</p>';
document.body.appendChild(loading);
const status = loading.querySelector('p')!;

const game = new Game(canvas);
game
  .init(mapId, (msg) => (status.textContent = msg))
  .then(() => loading.remove())
  .catch((err) => {
    loading.remove();
    console.error(err);
    document.getElementById('ui')!.innerHTML = `<pre style="color:#f66;padding:20px">${String(err?.stack ?? err)}</pre>`;
  });

if (import.meta.env.DEV) Object.assign(window as any, { game, Events });
