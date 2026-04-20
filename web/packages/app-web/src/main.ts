import { Game } from './game.js';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
const overlay = document.getElementById('overlay') as HTMLDivElement | null;
const startBtn = document.getElementById('start') as HTMLButtonElement | null;

if (!canvas || !overlay || !startBtn) {
  throw new Error('required DOM elements missing');
}

async function run(): Promise<void> {
  const res = await fetch('/demo.dtx');
  if (!res.ok) throw new Error(`failed to load demo.dtx: ${res.status}`);
  const text = await res.text();

  const game = new Game(canvas!);
  overlay!.style.display = 'none';
  await game.loadAndStart(text, {
    onRestart: () => {
      game.stop();
      overlay!.style.display = 'grid';
    },
  });
}

startBtn.addEventListener('click', () => {
  run().catch((e) => {
    console.error(e);
    alert(`failed to start: ${(e as Error).message}`);
  });
});
