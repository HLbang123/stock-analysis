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
    date: '2026-08-17',
    items: [
      '涨停封板提醒移除：保留涨停炸板预警',
      '买入信号分级调整：箱体信号升为强信号；反包入场、均线多头排列经十年回放验证效果不佳，移出买入共振；再移除两个无效见顶形态',
    ],
  },
  {
    date: '2026-08-15',
    items: [
      'AI 筛选策略按十年历史数据调优：强化入场点维度，剔除实测无效维度，深度回调的标的不再被风控误压分',
      'AI 筛选打分新增「吸筹箱体」维度：十年回放中表现最强的形态条件',
      '全市场扫描按十年回放优化：上升期/回踩预设去掉多头排列、乖离率收紧，市场防守期勾选趋势类条件时给出提示',
      '全市场扫描新增「吸筹箱体」预设',
      '预警规则优化：移除两个实测无效的见顶形态信号，减少误报',
    ],
  },
  {
    date: '2026-08-14',
    items: [
      '修复持仓截图识别，现在可正常识别',
      '粘贴文本提取升级：除代码外还能识别标的名称',
      '进入详情页返回后来源页停在原处',
      'ETF 预警适配',
      '全市场扫描新增「阶段」预设与趋势条件：多头排列/三线上行/距一年新高/乖离率/缩量/吸筹箱体，均可勾选调值，预设一键套用',
      'AI 筛选新增市场状态标记：进攻期/防守期徽章，数据过期时明确提示',
      '详情页分时图改为固定视图，K线默认展示最近20根、支持左右滑动与横向缩放',
    ],
  },
  {
    date: '2026-08-13',
    items: [
      '新增「分享」：把自选分组分享给群友，输分享码即可订阅查看、一键移入自己的自选',
      '盘前提示与日报重做：AI 市场解读、板块资金流向、预警触发统计，修复多处数据错误，数据缺失时明确提示',
      '首页只展示当前有效预警：已失效信号不再划线占位，历史预警可在标的详情页查看',
      '移除详情页分时/K线图上的预警红点标记',
      '新增粘贴文本提取标的：直接粘贴持仓/关注列表文本即可批量识别加入自选',
    ],
  },
  {
    date: '2026-08-12',
    items: [
      '云同步可查看已连接设备，支持改名与移除',
      '自选支持多选批量删除',
      '扫描与详情页的自选按钮支持直接删除',
      '修复详情页返回总是回首页的问题',
      '修复深度分析换手率误用昨日数据的问题，盘中改为实时换手率',
    ],
  },
  {
    date: '2026-08-11',
    items: [
      '市场扫描新增「AI 筛选」标签页：每日自动跑，全员共享，不再需要个人 AI 配置',
      '预警列表支持按自选分组过滤',
      '复盘弹窗收拢为 盘前提示/日报/周报/胜率复盘 四个标签，三个胜率面板合并进胜率复盘',
      '修复大盘页板块资金流向条形与数值不符、看不到净流出板块的问题；行业强度榜改按占比排序',
      '全市场扫描结果上限提升至 200 只，扫描结果支持一键加自选，RPS/最新价/日涨跌支持点击排序',
      '持仓截图识别提速提准：结果支持一键全部加自选',
    ],
  },
  {
    date: '2026-08-10',
    items: [
      '深度分析数据修正：大盘指数改实时行情，盘后数据统一标注所属交易日；修复资金流显示恒为 0 的问题',
      '预警规则优化：卖出信号按严重度分级展示，弱提醒不再染绿整卡/摘买入徽章；删除无区分度的「MA5拐头」；5/13死叉改为跌破55日线才清仓、站上为假死叉减仓；修复买入信号复活失败产生重复预警、过期信号误计入买入共振',
      '深度分析与 AI 对话新增龙虎榜机构/游资席位解读；标的详情页新增行业/概念标签',
      '修复除权除息后涨幅假跌污染 RPS 排名与扫描结果的问题',
      '市场扫描 RPS 周期与金叉窗口支持多选；移除 VCP 波动率收缩筛选',
    ],
  },
  {
    date: '2026-08-07',
    items: [
      '新增「复盘」入口（首页顶部）：周报、深度分析胜率、AI筛选胜率、预警规则健康四处数据收拢一处，分页签切换',
      '新增「云同步」：自选、分组、AI 配置、分析历史加密备份，换设备用配对码即可恢复，自动同步实时更新',
      '深度分析提速约一半',
      '深度分析、AI 对话正文支持逐字实时输出',
    ],
  },
  {
    date: '2026-08-06',
    items: [
      'AI 分析、波段评分、AI 对话响应速度明显提升',
      '深度分析进度自动保存，中断/刷新/锁屏后可一键「继续生成」',
    ],
  },
  {
    date: '2026-08-05',
    items: [
      '预警页移除标题旁未读数字徽章',
      '深度分析胜率复盘升级：低样本胜率灰显防误读、月度胜率趋势、盈亏比列、失败可重试',
      '优质建议榜重构：按标的合并去重，分「高胜率背书」「近期高信心」两组',
      'AI 筛选轻量化 + 阶段指示器：耗时费用明显下降，等待时展示进度与秒数',
      '修复多个预警规则误报，移除无效信号',
      '新增「预警规则健康」面板：持续监控各规则的实战胜率',
      '新增「本周回顾」：周五晚自动生成周报（市场/筛选/深度分析/预警统计）',
      '数据源升级：行业与标的资金流向（含大中小单结构）、ETF 净值走势、全市场精确涨跌停价',
    ],
  },
  {
    date: '2026-08-04',
    items: [
      '前端重构，全站样式收敛',
      '预警页 UI 升级：未读徽章、信号色条区分方向、买入共振改用语义色',
      '自选页新增分组管理：分组增删改、标的移入指定组、按组筛选',
      '预警卡片恢复整框着色（买红卖绿），并按严重程度排序、已消失信号沉底',
      'AI 筛选结果支持按综合分/涨跌幅点击排序',
      'AI 分析支持直接搜索标的，无需先加自选',
      '全市场扫描板块精简为搜索框：搜名称直达一级/二级行业',
      '深度分析新增进度条',
      '自选卡片新增均线交叉徽标：金叉/死叉/即将金叉',
    ],
  },
  {
    date: '2026-08-03',
    items: [
      '修复 AI 筛选结果排序问题',
      '预警规则新增 5/10 金叉买入信号',
      '预警页新增「买入共振强度档位」：按买入信号强弱分 弱观察/温和看多/较强看多/强烈共振',
      '深度分析新增「胜率复盘」面板：建议方向胜率榜、目标/止损命中率、置信度/仓位校准（在历史分析中切换）',
      '标的详情页新增「支撑压力位」：结构位 + 黄金分割回撤，卡片展示 + K线图叠加虚线；深度分析结果同步展示',
      '波段评分做T规则优化',
    ],
  },
  {
    date: '2026-07-31',
    items: [
      'AI 对话支持多标的对比：添加自选最多 5 只，横向对比行情/基本面/筹码',
      '深度分析重做：目标价/止损/仓位建议由规则引擎定区间，更稳健',
      '深度分析仓位建议联动大盘强弱',
      '深度分析新增历史建议胜率统计（T+5/10/20）',
      '修复波段评分因子分解显示问题',
      '修复部分大盘金融类标的基本面数据缺失',
      '分析结果与对话持久化：切界面/切路由不再丢失，AI 对话保留至主动开新对话',
      '预警主页新增「规则说明」按钮：可查看全部预警规则的含义、级别与触发条件',
    ],
  },
  {
    date: '2026-07-30',
    items: [
      'AI 筛选每策略入选数 10→20，移除结果展示数量自选、默认 20',
      '「心姐分析」快速档重做为「波段评分」：确定性买点/卖点双信号分(各 0-100)',
      '修复全市场扫描过滤型查询空白',
      '全市场扫描新增流通市值过滤：可选下限过滤小市值标的',
    ],
  },
  {
    date: '2026-07-29',
    items: [
      'AI 筛选打分逻辑重构，消除因子间互相干扰，4 策略重定权重',
      '新增「胜率复盘」面板：策略排行、因子有效性、重排效果对比',
      'AI 筛选新增板块+主板过滤:结果可按申万行业/创业板/科创板/北交所切片查看',
      'AI 筛选结果展示数量可自选(10/20/30)',
      '修复全市场扫描板块过滤失效',
      '修复详情页 5/13 死叉标签长期不消失:死叉后过几天自动改为"空头排列",只有最近发生穿越才显示金叉/死叉',
    ],
  },
  {
    date: '2026-07-28',
    items: [
      '新增筹码峰分析：详情页筹码分布，新增筹码低位密集/高位套牢两条弱提醒',
      'AI 深度分析与对话接入筹码分布数据（主峰/平均成本/获利盘/集中度），对话新增筹码查询工具',
      '全市场扫描新增 RSI 过滤：周期可选 6/12/24 日，上下限自设，支持筛超卖或超买',
      '预警规则精简：移除 RSI 底背离，超卖信号加趋势过滤',
      '新增站稳五日线加仓信号：连续3日收盘站上 MA5 且 MA5 上行时提示加仓',
      '买入信号共振聚合：同日多个买入信号在预警页折叠为"买入共振·N条"，可展开看明细',
      '过热预警信号重构：改用涨停封板/涨停炸板判定',
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
      '修复预警页与详情页技术指标数值不一致的问题',
      'AI 分析与对话新增可折叠「思考过程」展示',
      '行情数据源新增第三备用源，单源故障自动切换更稳',
    ],
  },
  {
    date: '2026-07-22',
    items: [
      '预警规则重构：29条合并精简为16条，一只票破位/见顶只出一条预警，去冗余',
      '新增均线多头排列信号；5/13金叉升级为分级买点（55日线上方强买/下方谨慎）',
      '移除横盘滞涨/缩量阴线健康/大阳调整等多条噪声规则',
      '大盘页新增：涨停情绪（连板/封单/炸板）、行业涨跌幅排行、板块资金流向、热度排行',
      '新增标的异动原因、热门榜单、ETF基金持仓',
      '扫描器优化：金叉新增「即将金叉」、55日线改为价格在55日线上方、板块动态化（全申万行业）、修复首次查询空结果bug',
      'AI对话新增工具：异动原因/涨停池/热榜/基金持仓查询',
      'ETF 深度分析纳入基金重仓数据',
    ],
  },
  {
    date: '2026-07-21',
    items: [
      '新增「大盘」页：市场宽度/大势温度/行业强度/指数估值分位/北向资金/融资融券',
      '全市场扫描重构：删规则模式，RPS+5/13金叉+55日线朝上+ROE 四重过滤',
      '标的详情页强化：RPS徽章+趋势状态+基本面速览+资金流向mini图',
      'AI 对话支持主动查询行情/K线/RPS/大盘等数据',
      '深度分析优化：纳入 RPS 强度、仓位建议更灵活、支持用户观点参与辩论',
      '新增口令门禁：进站需输口令进入，一次输入30天有效',
    ],
  },
  {
    date: '2026-07-20',
    items: [
      '修复 RPS 全市场排名永远滞后一天',
      '修复多项数据问题',
      '修复行情涨跌幅显示精度问题',
      '新增三条均线规则：5/13死叉、5/13金叉、跌破55日线',
      '扫描页状态持久化',
      'AI 对话新增「附带分析结论」开关',
    ],
  },
  {
    date: '2026-07-19',
    items: [
      '全市场扫描新增 RPS 排序模式 + 申万行业列表',
      '搭建 RPS 全市场排序，补全技术指标',
      '预警引擎从 17 条扩展至 26 条',
    ],
  },
  {
    date: '2026-07-18',
    items: [
      'AI 深度分析接入基本面 + 资金面数据',
      '深度分析重构为多空辩论模式',
      '深度分析辩论人格化、稳定性改进',
    ],
  },
  {
    date: '2026-07-17',
    items: [
      'AI 对话功能上线：流式回复、标的上下文、市场状态感知',
      '支持 ETF：分析、分时图与列表适配',
      '深度分析增强：技术指标、辩论、信心指数、建议仓位',
      '修复部分 iOS Safari 点击无响应问题',
    ],
  },
  {
    date: '2026-07-16',
    items: [
      '流式 AI 分析 + 深度分析三阶段 + UI 优化',
      '本地标的搜索：全量 5200 只，备用源自动切换',
      '搜索自动完成：过滤北交所/非沪深标的、分时图去重修复',
      'AI 错误提示改为自然语言',
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
      '项目初始化：技术形态预警系统',
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
• 大模型 API（DeepSeek）：50 元｜2026-08-11 支出
• 合计：1549 元`;

export function UpdateLog({ onShowRules }: { onShowRules?: () => void }) {
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
          {onShowRules && (
            <button
              onClick={() => { setMenuOpen(false); onShowRules(); }}
              className="w-full px-3 py-2 text-sm text-left text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition border-t border-gray-100 dark:border-gray-800"
            >
              规则说明
            </button>
          )}
        </div>
      )}

      {/* 第二级：抽屉/弹窗（z-[60] 高于底部导航，防移动端被挡） */}
      {panel && (
        <div
          className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/40"
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
