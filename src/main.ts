import './ui/hud.css';
import { Game } from './Game';
import { installDevTools } from './dev/DevTools';

const game = new Game(document.getElementById('app')!);
installDevTools(game);
game.start();
