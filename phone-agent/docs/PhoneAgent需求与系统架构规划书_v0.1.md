# 📱 CodePlant Phone Agent — 需求与系统架构规划书（v0.1）

> **文档版本**：`v0.1`（M0 架构冻结与工程脚手架落盘版） ｜ **创建日期**：`2026-11-26`  
> **目标设备**：小米 14（HyperOS，**无 Root**，**暂不具备开启「USB 调试（安全设置）」条件**）  
> **代码演进仓库**：[`TuesCool/CodePlant`](https://github.com/TuesCool/CodePlant)（后续迭代提交与 GitHub Actions 云编译 APK 均托管于此）  
> **核心参考基线**：[`haaharden/Zai`](https://github.com/haaharden/Zai)、[`earendil-works/pi`](https://github.com/earendil-works/pi)（`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`）

---

## 一、核心需求与边界锁定（In-Scope / Out-of-Scope）

### 1.1 用户核心诉求清单
1. **稳定控屏（绝不半路掉权重启）**：针对 MI14 无 Root 且无「USB 调试（安全设置）」的硬约束，保障长任务不断连、不反复弹授权。
2. **多模型与自动发现 + ChatGPT 订阅登录**：
   - 支持填入任意 OpenAI 兼容 / Responses / Anthropic `Base URL + API Key`，自动请求 `/models` 发现模型并按任务路由（主控 / 视觉看图 / 上下文压缩）；
   - 支持复用 ChatGPT Plus/Pro 账号 OAuth（`openai-codex`）。
3. **上下文滚动压缩**：支持超长控屏/对话会话的自动化裁剪（先折叠旧截图与旧控件树，再触发滚动摘要），防止上下文爆炸与 Token 浪费。
4. **个人管家核心场景闭环**：
   - **虫部落信息采集**：**优先后台 HTTP 抓取解析**（快、省 Token），遇到需登录/动态渲染页面时降级走手机控屏，整理结果落盘；
   - **微信半自动交互**：**通知栏监听 + 白名单自动回复**；**拨打视频通话必须触发二次确认或严格受限于视频白名单**；
   - **待办 → 每日计划 → 原生通知督促 → 每周复盘自迭代**：根据沟通需求生成待办，每日自动排期并通过手机原生通知督促执行；每周汇总完成度与卡点生成复盘报告，并经确认后回写 `preferences.md` 实现系统行为迭代优化。
5. **交互入口与扩展性**：
   - Web 聊天页 + 看板作为主交互入口（手机浏览器本机访问 + 电脑局域网/内网穿透遥控）；
   - 后续接入新手机 App 采用**声明式 `skills/apps/<app>.md` + 通用控屏原语**，无需每次改 App 源码重编 APK。

---

## 二、关键架构决策（ADR 台账）

| ADR 编号 | 决策主题 | 最终选型 | 工程依据与参考对比 |
| :--- | :--- | :--- | :--- |
| **ADR-001** | **核心运行形态** | **路线 A：Termux (`pi-server`) + 极简 Kotlin Portal APK** | 相比 [`haaharden/Zai`](https://github.com/haaharden/Zai) 的单 APK WebView V8 方案，路线 A 将大脑完全放在 Termux Node.js 环境：<br>1) 天生适配 **虫部落后台直连抓取**、本地 Markdown/JSON 知识库与定时 `cron` 督促；<br>2) 调整 Agent 逻辑、Prompt、App Skill、复盘算法时**无需重新云编译 APK**；<br>3) 仍可深度借鉴 `Zai` 的混合感知、SafetyGuard 门禁、双通道接口与 `pi-ai`/`pi-agent-core` 集成方式。 |
| **ADR-002** | **MI14 无「安全设置」控屏策略** | **AccessibilityService 主控 + Shizuku 辅助截屏/诊断** | 在 MI14 未开「USB 调试（安全设置）」时，HyperOS 会以 `SecurityException` 拦截 Shizuku `input tap/swipe/injectInputEvent` 与 `pm grant`。因此：<br>• **触控/滑动/中文输入/控件树** 100% 走 **AccessibilityService**（`dispatchGesture` + `ACTION_SET_TEXT` + `captureScreenTree`），仅需用户完成一次“允许受限设置”+ 无障碍开启 + 后台锁卡；<br>• **Shizuku (`uid 2000`)** 负责**静默 `screencap -p` 截屏**（免系统录屏弹窗）、`uiautomator dump` 兜底与诊断命令；<br>• 若未来具备条件开启「USB 调试（安全设置）」，Portal 层已预留配置位，可无缝切回 Shizuku 触控注入与无障碍自愈。 |
| **ADR-003** | **屏幕感知策略** | **精简控件树为主 + 按需 SoM 截图兜底** | 默认向模型传入剪枝编号控件树 `[1] [2]...`（1~3 KB，省 70%+ Token 且坐标 100% 精准）；仅当有效节点 `< 5`、连续 2 步界面无变化或模型主动调用 `phone_screenshot` 时，才抓取并发送压缩截图（可选叠画编号框）。 |
| **ADR-004** | **上下文滚动压缩** | **两级联动：历史感知折叠 + 阈值滚动摘要** | 第 1 级（无损省流）：每轮推理前自动把 2 轮之前的旧截图替换为 `[旧截图已折叠]`，把旧控件树折叠为摘要行；<br>第 2 级（滚动摘要）：当估算 Token ≥ 上下文窗口 75%（可调），由压缩模型将早期对话浓缩为 `RollingSummary` 并归档原始 JSONL，同时保留“初始目标 + 待办/偏好锚点 + 最近 4 轮原文”。 |
| **ADR-005** | **微信安全门禁** | **分层白名单 + 动作分级确认** | • **读消息**：通知栏被动监听，不主动刷屏；<br>• **自动回复**：仅对 `replyWhitelist` 联系人自动发送或生成草稿，非白名单一律仅生成草稿；<br>• **拨打视频**：`SafetyGuard` 强制拦截，**非 `videoWhitelist` 或未启用自动模式时**，必须通过 Web 端 + 手机原生高优通知点击“允许”后才放行，超时默认拒绝。 |
| **ADR-006** | **构建与交付链路** | **无本地 SDK → GitHub Actions 云编译 APK** | 电脑端不安装 Android Studio/SDK，利用 `TuesCool/CodePlant` 托管代码并通过 `.github/workflows/build-portal-apk.yml` 在云端自动编译 `app-debug.apk`（及签名 Release），直接下载安装到 MI14。 |

---

## 三、四层解耦系统架构

```text
┌────────────────────────────────────────────────────────────────────┐
│ 入口层：Web 聊天 & 管家看板 (手机浏览器 127.0.0.1:8787 / 电脑遥控)  │
│  • 模型配置 & /models 自动发现   • 对话与控屏执行流   • 二次确认弹窗 │
│  • 虫部落抓取卡片               • 待办 / 日计划 / 周复盘面板         │
└───────────────────────────────┬────────────────────────────────────┘
                                │ HTTP + SSE / REST
┌───────────────────────────────▼────────────────────────────────────┐
│ 引擎层：Termux Node.js + TypeScript (`pi-server`)                  │
│  ├── Pi Runtime: @earendil-works/pi-ai + pi-agent-core             │
│  ├── ModelRegistry: ChatGPT OAuth + 多端点发现 + 角色分流路由       │
│  ├── RollingCompactor: 旧截图/控件树折叠 + 滚动摘要 + JSONL 归档    │
│  ├── SafetyGuard: 微信回复白名单 + 打视频强确认 + 最大步数熔断       │
│  ├── ButlerCore: 待办库 + 每日计划器 + 督促 Cron + 周复盘自迭代     │
│  ├── Fetcher: 虫部落后台 HTTP 抓取（需登录/JS渲染时转控屏）         │
│  └── AppSkillLoader: 动态加载 skills/apps/*.md                     │
└───────────────────────────────┬────────────────────────────────────┘
                                │ 127.0.0.1:18788 (Bearer Token)
┌───────────────────────────────▼────────────────────────────────────┐
│ 端侧执行层：极简 Android Portal APK (`com.codeplant.portal`)        │
│  ├── PortalForegroundService + 内置微 HTTP Server                  │
│  ├── PortalAccessibilityService (主控：读树、手势点滑、文本输入)    │
│  ├── ShizukuBridge + UserService (uid 2000 静默 screencap 增强)    │
│  ├── PortalNotificationListener (监听微信等通知 → Webhook 推送)    │
│  └── NativeNotifier (督促强通知 + 带 Allow/Deny 按钮的确认通知)    │
└────────────────────────────────────────────────────────────────────┘
```

---

## 四、核心模块接口定义（ICD）

### 4.1 `pi-server` ⇄ `Android Portal APK` 本地协议（`http://127.0.0.1:18788`）
所有请求均携带 `Authorization: Bearer <PORTAL_TOKEN>`：

| 方法与路径 | 方向 | 用途 | 请求 / 响应核心字段 |
| :--- | :--- | :--- | :--- |
| `GET /health` | `pi` → Portal | 状态探活 | 返回 `accessibilityConnected`, `shizukuReady`, `notificationListenerConnected`, `foregroundPackage`, `screenWidth`, `screenHeight` |
| `GET /screen` | `pi` → Portal | 获取当前屏幕感知 | Query: `includeImage=0\|1`, `annotate=0\|1`；返回精简编号节点树 `elements[]` + 可选 Base64 JPEG 截图 |
| `POST /action` | `pi` → Portal | 执行手机动作 | `{ "type": "tap"\|"long_press"\|"swipe"\|"input"\|"key"\|"open_app", "x": 540, "y": 1200, "text": "...", "packageName": "..." }` |
| `POST /notify` | `pi` → Portal | 发送手机原生通知 | `{ "id": "...", "title": "...", "body": "...", "level": "reminder"\|"confirm", "confirmId": "..." }` |
| `GET /notifications` | `pi` → Portal | 拉取当前通知栏快照 | 返回近期系统通知列表（按包名过滤） |
| `POST /webhook/notification` | Portal → `pi` | 微信等新消息实时推送 | `{ "packageName": "com.tencent.mm", "title": "张三", "text": "...", "timestamp": 1732600000000 }` |
| `POST /webhook/confirm` | Portal → `pi` | 通知栏按钮点击回传 | `{ "confirmId": "...", "allow": true\|false }` |

### 4.2 `pi-server` ⇄ Web UI（`http://127.0.0.1:8787`）
- `GET /api/status`：返回 Portal 通道状态、当前模型、上下文 Token 占用百分比。
- `POST /api/models/discover`：输入 `{ baseUrl, apiKey, apiType }`，拉取远端 `/models` 并保存配置。
- `POST /api/chat`：发送自然语言指令，触发 Agent Loop（流式/JSON 返回步骤与回复）。
- `POST /api/compact`：手动立即触发上下文滚动压缩。
- `GET /api/confirmations` / `POST /api/confirmations/:id`：查看与审批挂起的高敏动作（如微信打视频）。
- `GET /api/butler/state` / `POST /api/butler/todos` / `POST /api/butler/plan/generate` / `POST /api/butler/review/weekly`：待办、日计划、周复盘接口。
- `POST /api/chongbuluo/search`：虫部落优先后台抓取搜索接口。

---

## 五、分阶段开发路线与验收标准（M0 ~ M3）

| 里程碑 | 核心交付内容 | 量化验收标准（DoD） |
| :--- | :--- | :--- |
| **M0（本轮已落盘脚手架）** | 规划文档 + MI14 手册 + `pi-server` 基础框架 + `android-portal` 基础工程 + GitHub Actions APK 云编译配置 | 1. 推送至 `TuesCool/CodePlant` 后 Actions 成功产出可安装 `app-debug.apk`；<br>2. MI14 安装后无障碍/通知监听/Shizuku 均显示就绪；<br>3. Web UI 输入 `Base URL + Key` 成功拉取模型列表，调用“获取屏幕控件树 + 点击 + 推送原生提醒通知”全链路跑通。 |
| **M1（虫部落 + 上下文压缩打磨）** | 完善虫部落多源抓取适配、动态页控屏兜底、真实 `pi-ai` 流式接入与 ChatGPT OAuth 手机端登录闭环 | 1. 输入关键词优先走后台抓取，3 秒内输出结构化 Markdown 摘要；<br>2. 连续 20 步以上长会话触发滚动压缩不超限、不丢初始目标。 |
| **M2（个人管家完整闭环）** | 需求→待办提取、每日时间块排期、Termux 定时督促通知、每周复盘报告生成与 `preferences.md` 自动调优 | 1. 每日按设定时间收到小米原生督促通知；<br>2. 一键生成本周复盘草稿，确认后自动更新偏好权重。 |
| **M3（微信白名单交互 + App 扩展体系）** | 微信通知栏事件路由、联系人白名单自动回复、打视频强二次确认、新增 ≥2 个自选 App Skill 模板 | 1. 白名单好友消息自动/草稿回复准确率符合预期，非白名单绝不误发；<br>2. 打视频必弹确认且拒绝后立即中止；<br>3. 新增 1 个 App 只需新增 1 个 `.md` 文件即可控制。 |

---

## 六、同步到 `TuesCool/CodePlant` 的仓库建议

由于 GitHub Actions **只会识别仓库根目录下的 `.github/workflows/`**，将本项目同步到 `TuesCool/CodePlant` 时建议采用以下两种结构之一：
- **方式 1（推荐，独立分支或独立子目录+根工作流）**：将本目录中的 `pi-server/`、`android-portal/`、`docs/` 推送到 `TuesCool/CodePlant`，并将本目录下的 `.github/workflows/build-portal-apk.yml` 放在 `TuesCool/CodePlant` 的根目录 `.github/workflows/build-portal-apk.yml`（需确保 workflow 内的 `working-directory` 指向 `android-portal` 实际路径）。
- **方式 2（单仓多项目）**：若 `TuesCool/CodePlant` 根目录还要保留原有嵌入式代码，可把本项目放在 `phone-agent/` 子目录下，仅将 workflow 的 `working-directory` 改为 `phone-agent/android-portal`。
