---
name: 虫部落信息搜索与整理
package: com.android.browser
triggers: 虫部落, chongbuluo, 搜索整理
---

## 执行策略（优先后台抓取，按需控屏）
1. **第一步（默认）**：直接调用工具 `chongbuluo_search_background`，由 Termux 后台直接请求虫部落入口并整理 Markdown。
2. **第二步（按需降级）**：仅当工具返回 `mode: "needs_phone_control"`（遇到登录态、动态 JS 渲染或验证码）时：
   - 调用 `phone_open_app` 打开浏览器；
   - 打开 `https://search.chongbuluo.com/` 或 `https://www.chongbuluo.com/`；
   - 使用 `phone_get_screen` + `phone_tap` + `phone_input_text` 完成搜索并提取结果整理为要点。
