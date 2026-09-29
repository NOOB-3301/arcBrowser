import { Game } from './core/Game';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(canvas);
game.init().catch((err) => {
  console.error(err);
  document.getElementById('ui')!.innerHTML = `<pre style="color:#f66;padding:20px">${String(err)}</pre>`;
});

if (import.meta.env.DEV) (window as any).game = game;
