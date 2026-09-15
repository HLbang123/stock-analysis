/**
 * 显式加载 .env.local。
 *
 * ⚠️ 为什么需要它：`lib/tushare.ts` 在模块加载时调 `dotenv.config({ path: ".env.local" })`，
 *    项目里有 26 个脚本靠**这个副作用**拿到 env —— 一旦某个脚本不 import tushare（如论点系统），
 *    `process.env.AI_SCREEN_API_KEY` 就是 undefined，服务器 key 静默失效、降级成模板，且**不报错**。
 *    （2026-09-14 生产实测踩到：卡片全部 narrated_by=template。）
 *
 * 用法：在脚本的**第一行 import** 引入本模块。
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
