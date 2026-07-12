# A股形态预警系统

基于"心姐知识整理"交易规则的 A 股 K 线形态识别与预警系统。

## 技术栈

- **前端**: React 18 + Vite + TypeScript + Tailwind CSS + lightweight-charts
- **后端 API**: Cloudflare Pages Functions（全球 CDN 边缘节点运行）
- **数据源**: 新浪财经 + 东方财富 + 腾讯财经（免费公开 API）
- **部署**: Cloudflare Pages（免费无限流量）

## 部署到 Cloudflare（推荐 — 免费、全球加速、无需服务器）

### 1. 推送代码到 GitHub

```bash
cd stock-analysis
git init
git add .
git commit -m "init: A股形态预警系统"
git branch -M main
git remote add origin https://github.com/你的用户名/stock-analysis.git
git push -u origin main
```

### 2. 在 Cloudflare Pages 部署

1. 打开 [dash.cloudflare.com](https://dash.cloudflare.com/) 注册/登录
2. 左侧菜单 → **Workers 和 Pages** → **创建** → **Pages**
3. **连接到 Git** → 授权 GitHub → 选择 `stock-analysis` 仓库
4. 构建设置：
   - **构建命令**: `cd frontend && npm install && npm run build`
   - **输出目录**: `frontend/dist`
   - **根目录**: `/`
5. 点击 **保存并部署**

3 分钟后部署完成，得到一个 `https://xxx.pages.dev` 域名，任何人打开就能用。

### 后续更新

```bash
git add .
git commit -m "更新内容"
git push
# Cloudflare 自动重新部署，无需手动操作
```

---

## 本地开发

### 1. 安装依赖
```bash
cd stock-analysis
npm install
cd frontend && npm install
```

### 2. 启动本地开发服务器

**方式 A：用本地 Express 后端**

```bash
# 终端 1 - 启动后端
cd backend && npm run dev    # 端口 3001

# 终端 2 - 启动前端（会自动代理 /api 到后端）
cd frontend && npm run dev   # 端口 5173
```

**方式 B：用 Cloudflare Pages Functions（模拟生产环境）**

```bash
cd frontend
npx wrangler pages dev -- npm run dev
```

然后访问 http://localhost:5173

---

## 预警规则体系

系统根据文档中的交易规则自动检测：

| 级别 | 含义 | 触发条件示例 |
|-----|------|------------|
| 🔴 红色 | 清仓离场 | 放量跌破5日线、对子顶三合一、突发暴跌 |
| 🟠 橙色 | 减仓信号 | 放巨量、长上影线出货、横盘滞涨 |
| 🟢 绿色 | 买入关注 | 第二波反包阳线、底背离、箱体突破 |
| 🔵 蓝色 | 观察提示 | 十字星企稳、长下影线、回调黄金分割 |

## 项目结构

```
stock-analysis/
├── backend/          # Express 后端（本地开发用）
│   └── src/
│       ├── routes/       # search, quote, kline, index
│       ├── services/     # sina, eastmoney, tencent
│       └── middleware/   # cache, rateLimiter
├── frontend/         # React 前端 + Cloudflare Functions
│   ├── functions/       # Cloudflare Pages Functions（生产环境 API）
│   │   ├── api/            # search, quote, kline, index
│   │   └── lib/            # sina, eastmoney, tencent, utils
│   └── src/
│       ├── components/   # chart, stock, alert, layout
│       ├── engine/       # 分析引擎（规则检测）
│       │   ├── indicators/  # MA, MACD, RSI
│       │   ├── patterns/    # 形态识别
│       │   └── rules/       # 买卖预警规则
│       ├── pages/        # HomePage, StockPage, WatchlistPage
│       ├── hooks/        # useKlineData, useQuote, useAlerts
│       └── store/        # Zustand 状态管理
└── package.json
```

## 免责声明

本系统通过算法自动计算 K 线数据生成的信号，仅供学习参考，不构成任何投资建议。股市有风险，投资需谨慎。
