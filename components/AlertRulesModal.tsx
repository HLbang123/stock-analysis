'use client';

import { useState } from 'react';
import { ALERT_RULES, isBuyRule, REFERENCE_RULE_IDS } from '@/services/alertRules';
import type { AlertRule } from '@/types';
import { cn } from '@/lib/utils';
import { Modal } from '@/components/ui/modal';
import { Tabs } from '@/components/ui/tabs';

interface Props {
  onClose: () => void;
}

type DocTab = 'alert' | 'tscore' | 'scan';

const levelColor = (level: string) =>
  level === 'CRITICAL' ? 'bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400' :
  level === 'WARNING' ? 'bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400' :
  'bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400';
const levelLabel = (level: string) =>
  level === 'CRITICAL' ? '严重' : level === 'WARNING' ? '注意' : '关注';

function RuleGroup({ title, hint, rules }: { title: string; hint: string; rules: AlertRule[] }) {
  if (rules.length === 0) return null;
  return (
    <div className="mb-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
        {title} <span className="text-xs text-gray-400 font-normal">· {hint}</span>
      </h3>
      <div className="space-y-2">
        {rules.map(r => (
          <div key={r.id} className="border border-gray-100 dark:border-gray-800 rounded-lg p-2.5">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-xs font-mono text-gray-400">{r.id}</span>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{r.name}</span>
              <span className={cn('text-xs px-1.5 py-0.5 rounded', levelColor(r.level))}>{levelLabel(r.level)}</span>
              {!r.isEnabled && <span className="text-xs text-gray-400">（已停用）</span>}
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed mb-1">{r.description}</p>
            <p className="text-xs text-blue-600 dark:text-blue-400">建议：{r.suggestion}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 通用说明条目：术语 + 一句话口径 */
function DocItem({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="border border-gray-100 dark:border-gray-800 rounded-lg p-2.5">
      <p className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-0.5">{name}</p>
      <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">{desc}</p>
    </div>
  );
}

function DocSection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
        {title} {hint && <span className="text-xs text-gray-400 font-normal">· {hint}</span>}
      </h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

// ==================== 预警规则 ====================

function AlertDoc() {
  const buy = ALERT_RULES.filter(r => isBuyRule(r.id) && !REFERENCE_RULE_IDS.has(r.id));
  const sell = ALERT_RULES.filter(r => !isBuyRule(r.id) && !REFERENCE_RULE_IDS.has(r.id));
  const ref = ALERT_RULES.filter(r => REFERENCE_RULE_IDS.has(r.id));

  return (
    <>
      <DocSection title="通用机制">
        <DocItem
          name="级别含义"
          desc="严重（红）=强卖出/离场信号，应果断处理；注意（黄）=趋势转弱或风险积累，减仓观察；关注（蓝）=机会提示或弱提醒，需自行确认。"
        />
        <DocItem
          name="阶梯规则（R01/R02）"
          desc="把同类信号合并成一条规则，内部按严重度择优只出最强的一条（如同时死叉+跌破5日线只报死叉），避免一只标的连刷多条重复预警。主信号严重度≥3 才算强卖出（整卡染绿、摘买入徽章）；≤2 为弱提醒，仅行内展示。"
        />
        <DocItem
          name="买入共振"
          desc="同一标的同日命中 ≥2 条买入规则时聚合成「买入共振」徽章，A级规则权重更高。参考信号（R13/R14）不计入共振。"
        />
        <DocItem
          name="盘中量能口径"
          desc="盘中「放量/缩量」按时间进度把已成交量折算成等效全日量再与均量比较（折算上限2倍，防早盘量能前置误报）；盘后按实际成交量。"
        />
        <DocItem
          name="品种适配"
          desc="ETF 不适用涨停/打板类信号（R01 自动跳过）；无换手数据的品种筹码规则（R13/R14）自动不触发；ETF 的急跌/突破类幅度阈值按自身波动率自动缩放。"
        />
      </DocSection>
      <RuleGroup title="卖出 / 风险信号" hint="破位·见顶·离场" rules={sell} />
      <RuleGroup title="买入 / 机会信号" hint="金叉·突破·站稳" rules={buy} />
      <RuleGroup title="参考信号" hint="筹码等辅助判断" rules={ref} />
    </>
  );
}

// ==================== 波段打分 ====================

function TScoreDoc() {
  return (
    <>
      <DocSection title="这是什么" hint="详情页买卖点双分">
        <DocItem
          name="买/卖双分（0-100）"
          desc="对自选标的盘中恒算两个分：买入分越高越适合低吸，卖出分越高越适合高抛。各由 8 个因子加权合成，AI 可在因子分基础上小幅微调（±15）。仅自选标的计算展示。"
        />
        <DocItem
          name="数据口径"
          desc="5/15 分钟 K 线由 1 分钟线聚合；尾盘（约 14:30 后）均值回归类信号打折；闭市或分时数据不足时降级不出分。"
        />
      </DocSection>
      <DocSection title="买入分因子" hint="分高=适合低吸">
        <DocItem name="回踩 VWAP" desc="现价贴近分时均价（VWAP）得分最高；偏离过多或跌破过深都减分。" />
        <DocItem name="日内低位" desc="现价处于当日高低价区间的低位得分高；追高（区间高位）减分。" />
        <DocItem name="缩量回踩" desc="下跌时段量能萎缩为健康回踩；尾盘放量下跌视为出货减分。" />
        <DocItem name="分时动量" desc="15 分钟动量温和转正最佳；过冷（深跌）过热（急拉）都减分。" />
        <DocItem name="日级趋势" desc="均线多头排列 / MACD 多头加分；回踩 MA20 幅度适中（未跌破）再加分。" />
        <DocItem name="无卖出信号" desc="预警引擎无卖出规则命中得分高；命中强卖出信号直接压到低分。" />
        <DocItem name="底部低吸（复合）" desc="回踩 15 分 K 前期低点支撑 + RSI(6)&lt;20 超卖 + RSI 底背离三项合成；二次探底不破并收回加分。下跌趋势中信号可信度打折。" />
        <DocItem name="15 分 MACD 水下金叉" desc="DIF 上穿 DEA 且在零轴下方（水下金叉）为强买信号；零轴上金叉次之。" />
      </DocSection>
      <DocSection title="卖出分因子" hint="分高=适合高抛">
        <DocItem name="高于 VWAP" desc="现价明显高于分时均价得分高；延伸过度（偏离过大）反而减分。" />
        <DocItem name="日内高位" desc="现价处于当日高低价区间的高位得分高。" />
        <DocItem name="放量上涨" desc="上涨时段量能充沛、尾盘放量拉升得分高。" />
        <DocItem name="分时动量过热" desc="15 分钟动量温和为正最佳；过热急拉视为赶顶减分。" />
        <DocItem name="日级过热" desc="RSI 超买、突破 20 日新高、站上筹码主峰加分；远低于 MA20 时无卖点。" />
        <DocItem name="卖出信号" desc="预警引擎命中的卖出规则越多分越高，至少 1 条保底 50 分。" />
        <DocItem name="冲高衰竭（复合）" desc="5 分 K 放量冲高/缩量滞涨/冲高回落 + RSI(6)&gt;80 超买 + 盘中 M 头 + RSI 顶背离四项合成。上升趋势中信号可信度打折。" />
        <DocItem name="15 分 MACD 水上死叉" desc="DIF 下穿 DEA 且在零轴上方（水上死叉）为强卖信号；零轴下死叉次之。" />
      </DocSection>
    </>
  );
}

// ==================== 市场扫描 ====================

function ScanDoc() {
  return (
    <>
      <DocSection title="核心概念">
        <DocItem
          name="RPS 相对强度"
          desc="标的近 N 日涨幅在全市场的百分位（0-100）：RPS60=87 即近 60 日涨幅超过全市场 87% 的标的。周期可选 20/60/120/250 日，多周期勾选=每个周期都达标（共振）。"
        />
        <DocItem
          name="乖离率（BIAS）"
          desc="现价相对均线的偏离度：（收盘÷均线−1）×100%。扫描里用的是 MA55 乖离（默认 0~20：在趋势内但未过热）和 MA13 乖离（默认 -3~5：上升通道内回踩）。"
        />
        <DocItem
          name="数据口径"
          desc="日线为前复权数据，每日收盘后更新，盘中扫描看到的是 T-1 口径。"
        />
      </DocSection>
      <DocSection title="阶段预设" hint="一键套用条件组合">
        <DocItem name="启动期" desc="近 5 日内 5/13 金叉或即将金叉 + 站上 55 日线。找刚脱离底部的票。" />
        <DocItem name="上升期" desc="三线上行 + 距一年新高 ≤25% + MA55 乖离 0~20%。找趋势已成且未过热的票。" />
        <DocItem name="回踩整理" desc="贴 MA13（乖离 -3~5%）+ 缩量整理。找上升趋势中的回调低吸点。" />
        <DocItem name="吸筹箱体" desc="近 60 根日 K 构成有效横盘吸筹箱体（现价处于箱体内）。回放中胜率最高的单条件，但与其他趋势条件互斥，故单独成一档。" />
      </DocSection>
      <DocSection title="趋势条件口径">
        <DocItem name="5/13 金叉" desc="MA5 上穿 MA13 发生在近 N 日内（窗口多选取并集）。「即将金叉」=MA5 仍低于 MA13 但差距 &lt;2% 且 MA5 上行中。" />
        <DocItem name="站上 55 日线" desc="现价高于 55 日均线（MA55）。" />
        <DocItem name="均线多头排列" desc="短 &gt; 中 &gt; 长均线连续保持 ≥N 日；组合可选 5&gt;10&gt;13 或 5&gt;10&gt;20。" />
        <DocItem name="三线上行" desc="MA5 / MA13 / MA55 三条线今日均高于 5 个交易日前。" />
        <DocItem name="距一年新高" desc="现价距离 250 日最高价 ≤X%，越强越接近新高。" />
        <DocItem name="缩量整理" desc="近 5 日均量 &lt; 前 20 日均量，回调中筹码沉淀。" />
        <DocItem
          name="吸筹箱体"
          desc="取最近 60 根日 K，箱顶/箱底=最高价 92% 分位 / 最低价 8% 分位（防单根长影线撑破箱体）。成立需同时满足：振幅 ≤20%（横盘越久允许越宽）；收盘价线性回归无单边（|归一化斜率| ≤0.0025 且 R²&lt;0.72，排除慢牛通道）；上下沿各触及 ≥2 次；中部 50% 区间收盘占比 ≥28%；3 日均线绕中轴有效摆动 ≥1 次；前后半段重心漂移 ≤8%。质量分 0-100 越高形态越标准；位置值 &lt;0=跌破箱底、0~1=箱内、&gt;1=突破箱顶。筛选口径为「现价处于箱体内」。"
        />
      </DocSection>
      <DocSection title="其他过滤">
        <DocItem name="ROE" desc="最近报告期净资产收益率 ≥ 设定值（默认 15%）。" />
        <DocItem name="RSI 区间" desc="RSI（6/12/24 可选）落在设定上下限内，如上限 30 筛超卖。" />
        <DocItem name="流通市值 / 板块" desc="流通市值下限（默认 100 亿）与板块（主板/创业板/科创板/北交所）过滤。" />
      </DocSection>
      <DocSection title="市场状态提示">
        <DocItem
          name="防守期提示"
          desc="当市场处于防守期（MA55 上方占比 ≤35% 或全市场 20 日收益中位数 ≤-4%）且勾选了趋势类条件时，查询按钮下方会提示「趋势类条件历史表现偏差」。原因：回放显示趋势型条件在防守期 T+20 均值明显为负。"
        />
      </DocSection>
    </>
  );
}

export function AlertRulesModal({ onClose }: Props) {
  const [tab, setTab] = useState<DocTab>('alert');

  return (
    <Modal title="规则说明" onClose={onClose}>
      <div className="p-4">
        <Tabs
          items={[
            { value: 'alert', label: '预警规则' },
            { value: 'tscore', label: '波段打分' },
            { value: 'scan', label: '市场扫描' },
          ]}
          value={tab}
          onChange={(v) => setTab(v)}
          className="mb-4"
        />
        {tab === 'alert' && <AlertDoc />}
        {tab === 'tscore' && <TScoreDoc />}
        {tab === 'scan' && <ScanDoc />}
      </div>
    </Modal>
  );
}
