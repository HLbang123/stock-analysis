import { classifyFund } from "../lib/fund-classify";

// [tsCode, name, fundType, benchmark, 期望assetClass, 期望tPlus0, 期望limitPct]
const cases: [string, string, string | undefined, string | undefined, string, boolean, number][] = [
  ['510300.SH', '沪深300ETF', '股票型', '沪深300指数收益率', 'equity', false, 10],
  ['588000.SH', '科创50ETF', '股票型', '上证科创板50成份指数收益率', 'equity', false, 20],
  ['159915.SZ', '创业板ETF', '股票型', '创业板指数收益率', 'equity', false, 20],
  ['513100.SH', '纳指ETF', 'QDII', '纳斯达克100指数收益率', 'cross-border', true, 10],
  ['513180.SH', '恒生科技指数ETF', 'QDII', '恒生科技指数收益率', 'cross-border', true, 10],
  ['159920.SZ', '恒生ETF', 'QDII', '恒生指数收益率', 'cross-border', true, 10],
  ['518880.SH', '黄金ETF', '另类投资型', '上海黄金交易所Au99.99现货实盘合约收益率', 'commodity', true, 10],
  ['517520.SH', '黄金股ETF', '股票型', '中证沪深港黄金产业股票指数收益率', 'equity', false, 10],
  ['159980.SZ', '有色期货ETF', '另类投资型', '上海期货交易所有色金属期货价格指数收益率', 'commodity', true, 10],
  ['512400.SH', '有色金属ETF', '股票型', '中证申万有色金属指数收益率', 'equity', false, 10],
  ['511260.SH', '十年国债ETF', '债券型', '上证10年期国债指数收益率', 'bond', true, 10],
  ['511380.SH', '可转债ETF', '债券型', '中证可转换债券及可交换债券指数收益率', 'bond', true, 10],
  ['511880.SH', '银华日利ETF', '货币型', '活期存款利率(税后)', 'money', true, 10],
  ['511990.SH', '华宝添益ETF', '货币型', '同期7天通知存款利率(税后)', 'money', true, 10],
  ['510880.SH', '红利ETF', '股票型', '上证红利指数收益率', 'equity', false, 10],
  ['513500.SH', '标普500ETF', 'QDII', '标普500指数收益率', 'cross-border', true, 10],
  ['515880.SH', '通信ETF', '股票型', '中证全指通信设备指数收益率', 'equity', false, 10],
  ['159509.SZ', '纳指科技ETF', 'QDII', '纳斯达克100科技板块指数收益率', 'cross-border', true, 10],
  ['511010.SH', '国债ETF', '债券型', '上证5年期国债指数收益率', 'bond', true, 10],
  ['513730.SH', '东南亚科技ETF', 'QDII', '新交所泛东南亚科技指数收益率', 'cross-border', true, 10],
  ['512160.SH', 'MSCI中国A股国际通ETF', '股票型', 'MSCI中国A股国际通指数收益率', 'equity', false, 10],
  ['159001.SZ', '保证金ETF', '货币型', '人民币活期存款利率', 'money', true, 10],
];

let pass = 0, fail = 0;
for (const [tsCode, name, fundType, benchmark, expClass, expT0, expLimit] of cases) {
  const r = classifyFund({ tsCode, name, fundType, benchmark });
  const ok = r.assetClass === expClass && r.tPlus0 === expT0 && r.limitPct === expLimit;
  if (ok) pass++;
  else {
    fail++;
    console.log(`✗ ${tsCode} ${name} → ${r.assetClass}/T0:${r.tPlus0}/${r.limitPct}%  期望 ${expClass}/T0:${expT0}/${expLimit}%`);
  }
}
console.log(`\n${pass}/${cases.length} 通过${fail ? `，${fail} 失败` : ''}`);
process.exit(fail ? 1 : 0);
