import {
  detectDragonFirstYinAt,
  detectLatestDragonFirstYin,
  scanDragonFirstYinSignals,
  evaluateDragonRegime,
  isMainBoardNonST,
  DragonBar,
  DragonFirstYinConfig,
} from '../lib/strategy/dragon-first-yin';
import { beijingTodayStr } from '../lib/stock-helpers';

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('PASS:', msg);
}

function bar(date: string, preClose: number, open: number, high: number, low: number, close: number, volume: number, turnoverRate: number | null = null): DragonBar {
  return { date, preClose, open, high, low, close, volume, turnoverRate };
}

// 3 个换手板 + 1 根假阴真阳首阴
const run3: DragonBar[] = [
  bar('2026-08-18', 9.80, 9.90, 10.00, 9.85, 10.00, 50000, 4),
  bar('2026-08-19', 10.00, 10.20, 11.00, 10.10, 11.00, 100000, 8),
  bar('2026-08-20', 11.00, 11.20, 12.10, 11.10, 12.10, 110000, 9),
  bar('2026-08-21', 12.10, 12.50, 13.31, 12.40, 13.31, 120000, 10),
  bar('2026-08-24', 13.31, 13.60, 13.65, 13.35, 13.45, 150000, 15),
];

const sig = detectDragonFirstYinAt(run3, 4);
console.log('signal:', JSON.stringify(sig, null, 2));
assert(sig.matched === true, '3换手板+假阴真阳应命中');
assert(sig.run?.boardCount === 3, '连板数为 3');
assert(sig.run?.quality === 'turnover', '换手板质量');
assert(sig.yin?.fakeYin === true, '首阴为假阴真阳');
assert(sig.priority === 'high', '优先级应为 high');
assert(sig.yin?.volumeRatio !== undefined && sig.yin.volumeRatio > 0, '量比已计算');

// 今天即首阴 → firstYinToday
const todayRun = run3.map((b, i) => (i === 4 ? { ...b, date: beijingTodayStr() } : b));
const latestToday = detectLatestDragonFirstYin(todayRun);
console.log('latest today:', JSON.stringify(latestToday, null, 2));
assert(latestToday?.signalType === 'firstYinToday', '首阴当日应返回 firstYinToday');

// 首阴在昨天，今天不是阴线 → firstYinYesterday
const nextDay: DragonBar = { date: beijingTodayStr(), preClose: 13.45, open: 13.70, high: 13.95, low: 13.60, close: 13.90, volume: 90000, turnoverRate: 8 };
const yesterday = detectLatestDragonFirstYin([...run3, nextDay]);
console.log('latest yesterday:', JSON.stringify(yesterday, null, 2));
assert(yesterday?.signalType === 'firstYinYesterday', '首阴次日应返回 firstYinYesterday');

// 只有 2 板 → 不符合 3~5 板范围
const run2: DragonBar[] = [
  bar('2026-08-18', 9.80, 9.90, 10.00, 9.85, 10.00, 50000, 4),
  bar('2026-08-19', 10.00, 10.20, 11.00, 10.10, 11.00, 100000, 8),
  bar('2026-08-20', 11.00, 11.20, 12.10, 11.10, 12.10, 110000, 9),
  bar('2026-08-21', 12.10, 12.40, 12.50, 12.20, 12.45, 100000, 10),
];
const sig2 = detectDragonFirstYinAt(run2, 3);
console.log('run2 signal:', JSON.stringify(sig2, null, 2));
assert(sig2.matched === false, '2板后首阴应拒绝');
assert(sig2.failedChecks.includes('board_count_out_of_range'), '失败原因应为板数超范围');

// 连续一字板：默认降级，skipAllOneWordRun 时直接拒绝
const oneWordBars: DragonBar[] = [
  bar('2026-08-18', 9.80, 9.90, 10.00, 9.85, 10.00, 50000, 4),
  bar('2026-08-19', 10.00, 11.00, 11.00, 11.00, 11.00, 8000, 1),
  bar('2026-08-20', 11.00, 12.10, 12.10, 12.10, 12.10, 9000, 1),
  bar('2026-08-21', 12.10, 13.31, 13.31, 13.31, 13.31, 10000, 1),
  bar('2026-08-24', 13.31, 13.60, 13.65, 13.35, 13.45, 15000, 3),
];
const sigOneWord = detectDragonFirstYinAt(oneWordBars, 4);
console.log('oneWord signal:', JSON.stringify(sigOneWord, null, 2));
assert(sigOneWord.matched === false, '连续一字板默认应被换手板门槛拒绝');
assert(sigOneWord.failedChecks.includes('turnover_board_too_low'), '失败原因应为换手板门槛');
const sigOneWordAllow = detectDragonFirstYinAt(oneWordBars, 4, { minTurnoverRate: 0 } as Partial<DragonFirstYinConfig>);
assert(sigOneWordAllow.matched === true, '关闭换手板门槛后连续一字板可进入观察池');
assert(sigOneWordAllow.priority === 'low', '连续一字板应降为低优先级');
const sigSkip = detectDragonFirstYinAt(oneWordBars, 4, { skipAllOneWordRun: true, minTurnoverRate: 0 } as Partial<DragonFirstYinConfig>);
assert(sigSkip.matched === false, '配置 skipAllOneWordRun 后应拒绝连续一字板');

// 量能暴增 → 拒绝
const explodeBars = run3.map((b, i) => (i === 4 ? { ...b, volume: 900000 } : b));
const sigVol = detectDragonFirstYinAt(explodeBars, 4);
console.log('volume explosion:', JSON.stringify(sigVol, null, 2));
assert(sigVol.matched === false, '首阴量能暴增应拒绝');
assert(sigVol.failedChecks.includes('volume_explosion'), '失败原因应为 volume_explosion');

// 历史扫描
const scanned = scanDragonFirstYinSignals(run3);
console.log('scanned count:', scanned.length);
assert(scanned.length === 1, '历史扫描应命中 1 次');

// 退潮期/核按钮
const defense = evaluateDragonRegime({ limitUpCount: 30, limitDownCount: 18, brokenCount: 12, highestBoard: 4, marketRegime: 'neutral' });
console.log('defense:', JSON.stringify(defense, null, 2));
assert(defense.mode === 'defense', '跌停多应判定退潮期');
assert(defense.tradable === false, '退潮期不可交易');

const attack = evaluateDragonRegime({ limitUpCount: 80, limitDownCount: 1, brokenCount: 10, highestBoard: 5 });
console.log('attack:', JSON.stringify(attack, null, 2));
assert(attack.mode === 'attack', '涨停多跌停少应判定进攻期');
assert(attack.tradable === true, '进攻期可交易');

// 范围过滤
assert(isMainBoardNonST('600519.SH', '贵州茅台') === true, '沪主板通过');
assert(isMainBoardNonST('002415.SZ', '海康威视') === true, '深主板通过');
assert(isMainBoardNonST('300750.SZ', '宁德时代') === true, '创业板通过');
assert(isMainBoardNonST('688981.SH', '中芯国际') === true, '科创板通过');
assert(isMainBoardNonST('830799.BJ', '艾融软件') === false, '北交所排除');
assert(isMainBoardNonST('600000.SH', 'ST某某') === false, 'ST排除');

// 日内洗盘变体：地天板式长下影，分歧转一致
const washBars = run3.map((b, i) => (i === 4 ? { ...b, open: 13.20, high: 13.50, low: 12.00, close: 13.45 } : b));
const washSig = detectDragonFirstYinAt(washBars, 4);
console.log('wash signal:', JSON.stringify(washSig, null, 2));
assert(washSig.matched === true, '长下影分歧转一致应命中龙首阴');
assert(washSig.yin?.isWash === true, '应标记为 isWash');
assert(washSig.yin?.isYin === false, '洗盘变体可以不是阴线');

console.log('ALL DRAGON FIRST YIN TESTS PASSED');
