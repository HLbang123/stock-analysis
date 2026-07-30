'use client';

import { useState, useEffect, useRef } from 'react';
import { Menu, X } from 'lucide-react';

/**
 * 更新日志 + 鸣谢 — 首页标题左侧的汉堡按钮。
 * 两级交互：点按钮 → 下方展开小菜单（更新日志 / 鸣谢）→ 再点进入抽屉。
 * 更新日志：往 CHANGELOG 数组头部追加一条 { date, items } 即可。
 */
interface ChangeEntry {
  date: string;      // YYYY-MM-DD
  version?: string;  // 可选版本号
  items: string[];
}

const CHANGELOG: ChangeEntry[] = [
  {
    date: '2026-07-30',
    items: [
      'AI 筛选每策略入选数 10→20，移除结果展示数量自选、默认 20',
      '「心姐分析」快速档重做为「波段评分」：基于 1 分钟分时(自算 VWAP)+日 K+筹码+预警引擎算确定性买点/卖点双信号分(各 0-100)，LLM 做 ±15 有界微调并给综合说明；信号参考非操作指令',
      '修复全市场扫描过滤型查询空白',
      '全市场扫描新增流通市值过滤：可选下限过滤小市值标的',
    ],
  },
  {
    date: '2026-07-29',
    items: [
      'AI 筛选胜率优先重构:8 因子精简为 7 且信号互不泄漏(趋势/入场点/波动/质量/流动性/板块/筹码),消除动量与稳定性互相打架;4 策略按论点重定权重',
      'AI 筛选全候选池落库:不只存入选 top-N,所有通过硬筛的候选都留底',
      '新增 T+N 回测回路:每日自动回填每只候选 T+1/T+5/T+20 真实收益与形态分类(突破/回踩)',
      '新增「胜率复盘」面板:因子 IC(信息系数)+5 分位胜率、策略排行榜、LLM 重排 A/B 对比(纯规则/融合/否决)、事件信号偏好·规避复盘',
      'AI 筛选新增板块+主板过滤:结果可按申万行业/创业板/科创板/北交所切片查看',
      'AI 筛选结果展示数量可自选(10/20/30)',
      '修复全市场扫描板块过滤失效',
      '修复详情页 5/13 死叉标签长期不消失:死叉后过几天自动改为"空头排列",只有最近发生穿越才显示金叉/死叉',
    ],
  },
  {
    date: '2026-07-28',
    items: [
      '新增筹码峰分析：日线换手率入库，AI 筛选新增筹码复合因子，新增 R18 筹码低位密集、R19 筹码高位套牢两条参考级弱提醒',
      'AI 深度分析与对话接入筹码分布数据（主峰/平均成本/获利盘/集中度），对话新增筹码查询工具',
      '全市场扫描新增 RSI 过滤：周期可选 6/12/24 日，上下限自设，支持筛超卖或超买',
      '预警规则精简：移除 RSI 底背离，R12 收窄为 RSI 超卖并加趋势过滤',
      '新增 R17 站稳五日线加仓信号：连续3日收盘站上 MA5 且 MA5 上行、站稳刚刚形成时提示加仓',
      '买入信号共振聚合：同日多个买入信号在预警页折叠为"买入共振·N条"，可展开看明细',
      'R02 见顶阶梯重构过热子信号：删除三连阳/连2天大涨/超大阳线，改为涨停封板/涨停炸板',
      '扫描器新增板块过滤：主板/创业板/科创板/北交所，按代码前缀筛选',
    ],
  },
  {
    date: '2026-07-27',
    items: [
      '卖出侧预警合并为两个阶梯规则（见顶阶梯+离场阶梯），杜绝"一条清仓一条减仓"的矛盾预警；统一K线形态定义，引入10日线分两段破位确认',
      '扫描器新增 VCP 波动率收缩形态过滤（趋势前置+三段递进收缩+量缩+贴近颈线），与金叉/55日线部分互斥',
      '扫描器板块选择器：L1 下显示二级方向提示，选中 L1 后可进一步展开选 L2',
      '新增「AI 筛选」（在 AI 分析页内切换）：规则硬筛→多因子打分→AI横向重排→风险/组合约束，4个策略预设',
    ],
  },
  {
    date: '2026-07-23',
    items: [
      '修复预警页不显示任何预警的bug',
      '修复 RSI 被盘中实时价拉偏的计算bug',
      '技术指标收口为单一数据源：预警页与详情页/AI页 RSI/MA 同源同值，不再两套算法分叉',
      'AI分析与对话新增可折叠「思考过程」展示（DeepSeek-R1/GLM 等推理模型 reasoning 透传）',
      '行情/K线数据源新增东方财富第三源 + 健康熔断自动降级，单源故障无缝切换更稳',
    ],
  },
  {
    date: '2026-07-22',
    items: [
      '预警规则重构：29条合并精简为16条，一只票破位/见顶只出一条预警，去冗余',
      '新增 R16 均线多头排列信号；5/13金叉升级为分级买点（55线上方强买/下方谨慎）',
      '移除横盘滞涨/缩量阴线健康/大阳调整/选股三原则等噪声规则',
      '大盘页新增：涨停情绪（连板/封单/炸板）、行业涨跌幅排行、板块资金流向、热度排行',
      '同花顺数据接入：个股异动原因、热股榜单、ETF基金持仓',
      '扫描器优化：金叉新增「即将金叉」、55日线改为股价在55线上方、板块动态化（全申万行业）、修复首次查询空结果bug',
      'AI对话新增工具：异动原因/涨停池/热榜/基金持仓查询',
      'AI对话与深度分析新增心跳保活：工具调用与阶段切换期间每15秒发送SSE心跳，防止长对话被代理或移动网络空闲超时掐断',
      'ETF深度分析注入基金重仓股数据',
      'Tushare高级接口：涨跌停统计+申万行业指数+行业成分股+个股资金流向同步',
    ],
  },
  {
    date: '2026-07-21',
    items: [
      '新增「大盘」页：市场宽度/大势温度/行业强度/指数估值分位/北向资金/融资融券',
      '全市场扫描重构：删规则模式，RPS+5/13金叉+55日线朝上+ROE 四重过滤',
      '股票详情页强化：RPS徽章+趋势状态+基本面速览+资金流向mini图',
      'AI对话支持 Function Calling：LLM可主动查行情/K线/RPS/大盘/北向/选股/历史涨幅',
      '深度分析优化：加RPS到prompt+软化仓位约束+用户看法加入辩论（降低权重防迎合）',
      '新增口令门禁：进站需输口令进入，一次输入30天有效',
    ],
  },
  {
    date: '2026-07-20',
    items: [
      '修复 RPS 全市场排名永远滞后一天',
      '修复多项 Tushare 数据 bug',
      '新增 MA55 均线指标（R029 规则用，避免与 MA60 混淆）',
      '修复行情 change 字段浮点误差',
      '新增「斐波那契数列均线规则」三条规则：R027 5/13死叉、R028 5/13金叉、R029 跌破55日线',
      '扫描页状态持久化',
      'AI 对话新增「附带分析结论」开关',
    ],
  },
  {
    date: '2026-07-19',
    items: [
      '全市场扫描新增 RPS 排序模式 + 申万行业列表 API',
      '搭建 RPS 全市场排序基础设施，补全技术指标，新增反封禁策略',
      '预警引擎从 17 条扩展至 26 条',
      'AI Prompt 重构为三层知识结构',
    ],
  },
  {
    date: '2026-07-18',
    items: [
      '接入 Tushare 数据：AI 深度分析支持基本面 + 资金面',
      '深度分析重构为多空辩论（心姐分析 + 全拆分辩论：并行 R1 + 串行 R2）',
      'FinGenius 改进：辩论人格化、Tushare 新接口、缓存层、卡死检测',
      '代码重构，强化 AI 分析',
    ],
  },
  {
    date: '2026-07-17',
    items: [
      'AI 对话功能上线：SSE 流式聊天、股票上下文、市场状态感知',
      'ETF 支持：代码识别统一、AI prompt 适配、分时图标记修复、ETF 列表抓取脚本',
      '深度分析五项增强：技术指标注入、辩论增强、反思记忆、信心输出、持仓占比',
      '修复部分 iOS Safari 点击无响应问题',
    ],
  },
  {
    date: '2026-07-16',
    items: [
      '流式 AI 分析 + 深度分析三阶段 + UI 优化',
      '本地股票缓存搜索：全量 A 股 5200 只，新浪备用源 + 重试',
      '搜索自动完成：过滤北交所/非沪深 A 股、分时图去重修复',
      'AI API 错误信息自然语言化',
      '持仓识别集成到自选页，网页标题改为「预警小工具」',
    ],
  },
  {
    date: '2026-07-15',
    items: [
      '添加 AI 分析、分钟 K 线图、新 UI 组件及多页面重构',
    ],
  },
  {
    date: '2026-07-13',
    items: [
      '重构项目，Web 版与安卓版功能对齐',
    ],
  },
  {
    date: '2026-07-12',
    items: [
      '项目初始化：A 股形态预警系统（Cloudflare Pages + Functions）',
    ],
  },
];

const THANKS = `这个小工具能跑起来，离不开群里大家的支持。

感谢群里大家赞助服务器费用，让这套预警系统能 7×24 小时稳定在线；

感谢群里大家赞助 Tushare 接口积分，让 AI 分析能拿到资金流向、融资融券、龙虎榜等专业数据；

也感谢每一位反馈 bug、提需求、分享实战经验的朋友——是你们让它越来越好用。

工具免费，数据有价，这份心意都记在心里。祝大家账户长红。

---

📦 项目开销记录

• 服务器（硅云香港）：899 元/年｜2026-07-16 支出
• Tushare 数据接口：600 元/年｜2026-07-18 + 2026-07-22 支出
• 合计：1499 元/年`;

export function UpdateLog() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<'log' | 'thanks' | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点外部关闭小菜单
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const openPanel = (p: 'log' | 'thanks') => {
    setPanel(p);
    setMenuOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setMenuOpen((v) => !v)}
        className="p-1.5 -ml-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 dark:hover:text-gray-300 transition"
        title="更新日志与鸣谢"
        aria-label="更新日志与鸣谢"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* 第一级：按钮下方的小菜单 */}
      {menuOpen && (
        <div className="absolute top-full left-0 mt-1 z-50 w-32 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-100 dark:border-gray-800 overflow-hidden">
          <button
            onClick={() => openPanel('log')}
            className="w-full px-3 py-2 text-sm text-left text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
          >
            更新日志
          </button>
          <button
            onClick={() => openPanel('thanks')}
            className="w-full px-3 py-2 text-sm text-left text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition border-t border-gray-100 dark:border-gray-800"
          >
            鸣谢
          </button>
        </div>
      )}

      {/* 第二级：抽屉/弹窗 */}
      {panel && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/40"
          onClick={() => setPanel(null)}
        >
          <div
            className="bg-white dark:bg-gray-900 w-full sm:max-w-lg max-h-[80vh] rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                {panel === 'log' ? '更新日志' : '鸣谢'}
              </h3>
              <button
                onClick={() => setPanel(null)}
                className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg transition"
                aria-label="关闭"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {panel === 'log' ? (
                <div className="space-y-4">
                  {CHANGELOG.map((entry) => (
                    <div key={entry.date}>
                      <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        {entry.date}{entry.version ? ` · ${entry.version}` : ''}
                      </p>
                      <ul className="space-y-1.5">
                        {entry.items.map((item, i) => (
                          <li key={i} className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed flex gap-2">
                            <span className="text-gray-300 dark:text-gray-600 shrink-0">·</span>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed whitespace-pre-wrap">
                  {THANKS}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
