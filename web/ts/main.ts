import { Game } from './game.js';
import { initFx } from './fx.js';
import { seedToolboxInit } from './seedtool.js';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const game = new Game(canvas);
(window as unknown as { __game?: Game }).__game = game;
game.applySize();
game.start();
seedToolboxInit();
// 装饰特效：在 start() 之后装，确保棋盘已经能正常接收事件。
// fx 层只读事件、不改事件（pointer-events:none + 无 preventDefault），
// 所以左键翻开 / 右键插旗 / 触摸手势都不受它影响。
initFx();
