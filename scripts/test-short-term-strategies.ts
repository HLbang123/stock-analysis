import {
  detectLimitUpThreeYinAt,
  ThreeYinBar,
} from '../lib/strategy/limit-up-three-yin';
import {
  detectDoubleDragonBoard,
  detectDoubleDragonPullback,
  DoubleDragonBar,
} from '../lib/strategy/double-dragon';

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('PASS:', msg);
}

// ---- 涨停+三连阴 ----
const threeYinBars: ThreeYinBar[] = [
  { date: '2026-08-18', open: 10.50, high: 11.00, low: 10.40, close: 11.00, volume: 1000000, preClose: 10.00 },
  { date: '2026-08-19', open: 11.20, high: 11.30, low: 10.80, close: 10.95, volume: 800000, preClose: 11.00 },
  { date: '2026-08-20', open: 10.96, high: 11.00, low: 10.70, close: 10.80, volume: 600000, preClose: 10.95 },
  { date: '2026-08-21', open: 10.81, high: 10.85, low: 10.65, close: 10.70, volume: 400000, preClose: 10.80 },
];
const sy = detectLimitUpThreeYinAt(threeYinBars, 3);
console.log('three-yin:', JSON.stringify(sy, null, 2));
assert(sy.matched === true, '涨停+三连阴标准形态命中');

// ---- 双龙打板 ----
const ddBars: DoubleDragonBar[] = [
  { date: '2026-08-10', open: 9.90, high: 10.00, low: 9.80, close: 10.00, volume: 50000 },
  { date: '2026-08-11', open: 10.10, high: 10.50, low: 10.00, close: 10.30, volume: 60000 },
  { date: '2026-08-12', open: 10.40, high: 10.80, low: 10.30, close: 10.70, volume: 70000 },
  { date: '2026-08-13', open: 10.80, high: 11.10, low: 10.70, close: 11.00, volume: 80000 },
  { date: '2026-08-14', open: 11.20, high: 11.80, low: 11.10, close: 11.80, volume: 90000 },
  { date: '2026-08-15', open: 11.50, high: 12.10, low: 11.40, close: 12.10, volume: 120000 },
  { date: '2026-08-18', open: 12.20, high: 13.31, low: 12.10, close: 13.31, volume: 200000 },
  { date: '2026-08-19', open: 13.40, high: 14.64, low: 13.30, close: 14.64, volume: 300000 },
  { date: '2026-08-20', open: 14.50, high: 14.60, low: 13.00, close: 14.20, volume: 100000 },
  { date: '2026-08-21', open: 14.30, high: 14.90, low: 14.10, close: 14.80, volume: 120000 },
];
const board2Idx = 7; // 2026-08-19 is second board; first board 2026-08-18
const ddBoard = detectDoubleDragonBoard(ddBars, board2Idx);
console.log('dd board:', JSON.stringify(ddBoard, null, 2));
assert(ddBoard.matched === true, '双龙二板打板形态命中');

const ddPull = detectDoubleDragonPullback(ddBars, board2Idx);
console.log('dd pullback:', JSON.stringify(ddPull, null, 2));
assert(ddPull.matched === true, '双龙回踩形态命中');

console.log('ALL SHORT-TERM STRATEGY TESTS PASSED');
