# 📱 CodePlant Phone Agent（MI14 · 个人管家与控屏系统）

> **当前版本**：**`v0.2.0`**（MI14 控屏闭环 + 免费模型与 Pi Prompt Cache + 秘塔 AI 导出 + 个人知识库与多平台生态 + 外部网站桥接）  
> **目标设备**：小米 14（HyperOS · 无 Root · 无需「USB 调试（安全设置）」）  
> **演进仓库**：[`TuesCool/CodePlant`](https://github.com/TuesCool/CodePlant)  
> **技术底座**：[`earendil-works/pi`](https://github.com/earendil-works/pi)、Android `AccessibilityService`

---

## 📁 目录导航

| 目录 / 文件 | 用途说明 | 入口 |
| :--- | :--- | :--- |
| **`docs/`** | 系统需求与架构 (`v0.1`)、v0.2 扩展与平台接入架构全览、MI14 无安全调试实操清单 | [`系统扩展与平台接入架构说明_v0.2.md`](./docs/系统扩展与平台接入架构说明_v0.2.md)<br>[`PhoneAgent需求与系统架构规划书_v0.1.md`](./docs/PhoneAgent需求与系统架构规划书_v0.1.md)<br>[`MI14_HyperOS_无Root无安全调试实操清单.md`](./docs/MI14_HyperOS_无Root无安全调试实操清单.md) |
| **`pi-server/`** | 跑在 Termux (Node.js) 上的 Pi Agent 后端：应用感知、免费模型与缓存、秘塔检索导出、个人 KB 与连接器、网络桥接及 4-Tab 深色控制台 | [`package.json`](./pi-server/package.json)、[`src/index.ts`](./pi-server/src/index.ts)、[`TERMUX_SETUP.sh`](./pi-server/TERMUX_SETUP.sh) |
| **`android-portal/`** | Kotlin 极简执行壳 APK（`0.2.0`）：应用名/包名扫描、`tap_element` 节点直点、中文聚焦粘贴输入、`NotificationListener`、原生提醒 | [`app/build.gradle.kts`](./android-portal/app/build.gradle.kts)、[`MainActivity.kt`](./android-portal/app/src/main/kotlin/com/codeplant/portal/MainActivity.kt) |
| **`.github/workflows/`** | GitHub Actions 自动类型检查 + Android APK 云编译 | [`build-portal-apk.yml`](./.github/workflows/build-portal-apk.yml) |

---

## ✨ v0.2 核心能力一览

1. **可控的手机自动化与微信发送**：支持 `phone_list_apps` 查询已装应用包名、`phone_tap_element(index)` 按节点编号稳定点击、`phone_input_text(text, index)` 先聚焦再设置文本/剪贴板粘贴兜底。
2. **免费大模型预设 + 优雅降级提示**：内置智谱 GLM 免费（`glm-4.7-flash` / `glm-4.6v-flash`）、魔搭 ModelScope（`Qwen3` / `Qwen2.5-VL` / `DeepSeek-V3`）、阿里云百炼与 DeepSeek 官方；不支持视觉时顶部平滑提示并提供一键切换多模态模型胶囊。
3. **Pi Prompt Cache 省 Token 模块**：支持**低 / 中 / 高**三档命中梯度、自定义 `minPrefixTokens` 与前缀锁定轮数，展示分模型建议与实时 `cacheRead` 命中率。
4. **秘塔 AI 检索导出**：直连秘塔 API 检索网页/文库/学术并自动生成可下载 Markdown/JSON 文件。
5. **个人知识库 & 多平台接入框架**：本地 Markdown KB + **Obsidian / 语雀 / 飞书 / Notion / Gemini Notebook / 腾讯 ima** 连接器卡片（含直连与 MCP/控屏桥接策略说明）。
6. **网络共享与个人网站桥接**：内置 `0.0.0.0` / 端口映射配置、CORS、Bearer Token 鉴权及 `/api/bridge/manifest`、`/api/bridge/invoke` 对外网关。

---

## 🚀 升级与部署流程

1. **同步更新 `android-portal` APK（v0.2.0）**：
   - 在 GitHub Actions `Build CodePlant Portal APK` 下载最新 `app-debug.apk` 覆盖安装到 MI14；
   - 在 MI14 **应用管理 → `CodePlant Portal` → 权限管理** 确保开启 **「后台弹出界面：始终允许」**，并在无障碍与通知使用权中确认开启。
2. **更新 Termux `pi-server` 代码并启动**：
   ```bash
   cd ~/CodePlant/phone-agent/pi-server
   git pull
   npm install
   npm start
   ```
3. **手机浏览器打开 `http://127.0.0.1:8787`**：
   - 在 **「04 配置」** 启用智谱免费或魔搭等模型、调整 Pi Prompt Cache；
   - 在底部常驻命令栏直接输入：`打开微信，给文件传输助手发送消息：测试成功` 或 `查找音乐应用并播放歌曲`。
