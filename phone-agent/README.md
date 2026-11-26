# 📱 CodePlant Phone Agent（MI14 · 路线 A · 个人管家与控屏系统）

> **当前阶段**：**`v0.1 / M0`（需求架构规划 + 可同步云编译的 M0 工程脚手架已落盘）**  
> **目标设备**：小米 14（HyperOS · 无 Root · 未开启「USB 调试（安全设置）」）  
> **演进仓库**：[`TuesCool/CodePlant`](https://github.com/TuesCool/CodePlant)  
> **技术参考**：[`haaharden/Zai`](https://github.com/haaharden/Zai)、[`earendil-works/pi`](https://github.com/earendil-works/pi)

---

## 📁 目录导航

| 目录 / 文件 | 用途说明 | 入口 |
| :--- | :--- | :--- |
| **`docs/`** | 系统需求与架构规划书（`v0.1`）、小米 14 无安全调试专项配置清单 | [`PhoneAgent需求与系统架构规划书_v0.1.md`](./docs/PhoneAgent需求与系统架构规划书_v0.1.md)<br>[`MI14_HyperOS_无Root无安全调试实操清单.md`](./docs/MI14_HyperOS_无Root无安全调试实操清单.md) |
| **`pi-server/`** | 跑在 Termux (Node.js) 上的 Pi Agent 后端、多模型/OAuth、滚动压缩、虫部落抓取、微信风控、待办/计划/周复盘及 Web 控制台 | [`package.json`](./pi-server/package.json)、[`src/index.ts`](./pi-server/src/index.ts)、[`TERMUX_SETUP.sh`](./pi-server/TERMUX_SETUP.sh) |
| **`android-portal/`** | 极简 Kotlin 执行壳 APK（无障碍主控 + Shizuku 静默截屏 + 通知栏监听 + 原生督促/确认通知） | [`app/build.gradle.kts`](./android-portal/app/build.gradle.kts)、[`MainActivity.kt`](./android-portal/app/src/main/kotlin/com/codeplant/portal/MainActivity.kt) |
| **`.github/workflows/`** | 零本地 Android SDK 的 GitHub Actions 云编译 APK 工作流 | [`build-portal-apk.yml`](./.github/workflows/build-portal-apk.yml) |

---

## 🚀 首次上线流程（5 步跑通 M0）

1. **推送到 [`TuesCool/CodePlant`](https://github.com/TuesCool/CodePlant)**：
   - 将本目录下 `docs/`、`pi-server/`、`android-portal/` 推送到 `TuesCool/CodePlant`；
   - 将 [`.github/workflows/build-portal-apk.yml`](./.github/workflows/build-portal-apk.yml) 放到 `TuesCool/CodePlant` **仓库根目录** `.github/workflows/` 下（若代码放在子目录，同步修改 workflow 里的 `working-directory`）。
2. **云编译下载 APK**：在 GitHub 仓库 → **Actions** → 运行工作流，下载产物 `codeplant-portal-debug-apk` 中的 `app-debug.apk` 安装到小米 14。
3. **完成 MI14 权限配置**：严格按 [`MI14_HyperOS_无Root无安全调试实操清单.md`](./docs/MI14_HyperOS_无Root无安全调试实操清单.md) 解锁「允许受限设置」、开启无障碍/通知使用权/自启动/省电无限制/后台锁卡。
4. **在手机 Termux 启动 `pi-server`**：
   ```bash
   cd ~/phone-agent/pi-server
   bash TERMUX_SETUP.sh
   npm start
   ```
5. **浏览器控制台调试**：手机浏览器访问 `http://127.0.0.1:8787`，填入 API `Base URL + Key` 点「自动找模型」（或点击 ChatGPT OAuth 登录），确认右上角 Portal / 无障碍 / 通知监听均为绿色即可测试！
