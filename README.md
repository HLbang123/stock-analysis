# A股形态预警系统 - Web版

基于Android股票监控应用开发的Web版本，专为苹果用户设计，支持17条专业形态预警规则。

## 功能特性

### 🎯 预警规则（17条）
- **成交量类**: 巨量预警、巨量见顶、第二波见顶
- **形态类**: 长上影线、连阳预警、对子顶、横盘滞涨、止跌企稳
- **趋势类**: 破五日线、破趋势线、超大阳线、急跌预警
- **机会类**: 反包入场、箱体吸筹、黄金位反弹
- **情绪类**: 妇联定律（工业富联大跌预警）、缩量破位

### 📊 主要功能
- **实时行情**: 支持新浪、腾讯双数据源
- **预警检测**: 一键检测所有自选股的17条规则
- **自选管理**: 添加/删除自选股，实时刷新行情
- **股票筛选**: 快速扫描热门股或自定义股票
- **K线图表**: SVG原生渲染，支持点击查看详情

## 技术栈

- **框架**: Next.js 16 (App Router)
- **语言**: TypeScript
- **样式**: Tailwind CSS
- **状态管理**: Zustand
- **图标**: Lucide React
- **图表**: 自研SVG K线组件
- **部署**: Vercel (免费版)

## 开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 构建生产版本
npm run build

# 启动生产服务器
npm start
```

## 部署到Vercel

### 方式一: 通过Vercel CLI

```bash
# 安装Vercel CLI
npm install -g vercel

# 登录
vercel login

# 部署
vercel
```

### 方式二: 通过GitHub

1. 将代码推送到GitHub仓库
2. 访问 [vercel.com](https://vercel.com)
3. 点击 "New Project"
4. 选择GitHub仓库并导入
5. 配置项目设置（默认即可）
6. 点击 "Deploy"

### 方式三: 手动部署

```bash
vercel --prod
```

## 项目结构

```
stock-analysis/
├── app/
│   ├── components/     # UI组件
│   │   └── KLineChart.tsx
│   ├── lib/           # 工具函数
│   │   └── utils.ts
│   ├── services/      # 业务逻辑
│   │   ├── alertRules.ts   # 预警规则引擎
│   │   └── stockApi.ts     # 股票API
│   ├── store/         # 状态管理
│   │   └── index.ts
│   ├── types/         # 类型定义
│   │   └── index.ts
│   ├── page.tsx       # 预警页（首页）
│   ├── watchlist/     # 自选页
│   ├── scanner/       # 筛选页
│   └── layout.tsx     # 根布局
├── public/            # 静态资源
├── vercel.json        # Vercel配置
└── package.json
```

## 注意事项

### CORS问题
- 股票数据API来自新浪财经、腾讯财经
- 直接从浏览器访问可能遇到CORS限制
- 解决方案：部署后使用Vercel代理或添加CORS头

### 数据源限制
- 数据来源于公开API，可能不稳定
- 建议添加备用数据源或错误处理

### Vercel免费版限制
- 构建时间: 60秒
- 函数执行: 10秒（本应用主要为客户端执行，不受限制）
- 带宽: 100GB/月
- 部署次数: 无限

## License

MIT