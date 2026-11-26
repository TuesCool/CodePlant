# 🛠️ 小米 14（HyperOS · 无 Root · 未开「USB 调试（安全设置）」）实操与避坑清单

> **核心结论**：因为当前**不具备开启「USB 调试（安全设置）」的条件**，HyperOS 会拦截通过 Shizuku/ADB 注入触摸（`input tap` / `injectInputEvent`）以及 `pm grant` / `settings put secure` 等高敏修改。  
> **正确解法**：把**触控、滑动、中文输入、读屏**交给 **Android 无障碍服务（AccessibilityService）**；把**无弹窗静默截屏（`screencap`）与诊断**交给 **Shizuku（无线调试启动）**；并通过 HyperOS 专项保活设置防止服务被杀。

---

## 一、第一步：安装与准备基础工具（避开商店旧版）

1. **Shizuku（强烈建议 GitHub 最新版）**：
   - 从 GitHub `RikkaApps/Shizuku` Releases 下载 **v13.6.0+**（Play 商店版长期停更，HyperOS 兼容性差）。
2. **Termux（GitHub / F-Droid 版）**：
   - 从 GitHub `termux/termux-app` Releases 下载通用或 `arm64-v8a` 版（**严禁使用应用商店或 Play 商店已废弃版本**）。
3. **CodePlant Portal APK**：
   - 推送代码到 `TuesCool/CodePlant` 后，从 GitHub Actions 的 `Artifacts` 下载编译好的 `app-debug.apk` 安装到 MI14。

---

## 二、第二步：解锁侧载 APK 的「受限设置」（HyperOS 必踩坑）

Android 13/14/15+ 对侧载安装的 APK 默认禁止开启“无障碍服务”和“通知使用权”，点击开关会提示 **“受限设置：为保障安全，此设置目前不可用”**。按以下顺序解锁：

1. **先故意点一次触发登记**：
   - 打开 **设置 → 更多设置 → 无障碍 → 已下载的应用 → CodePlant Portal**，尝试打开开关，弹出“受限设置”提示后点 **确定**。
   - 同样去 **通知使用权** 里点一次 **CodePlant Portal** 触发登记。
2. **回应用详情页解锁**：
   - 打开 **设置 → 应用设置 → 应用管理 → CodePlant Portal**。
   - 点击右上角 **`⋮`（三个点）**（部分 HyperOS 版本在页面最底部），选择 **「允许受限设置」**，验证锁屏密码/指纹。
   - *注：若部分 HyperOS 精简视图隐藏了右上角菜单，可改用开源安装器 **SAI (Split APKs Installer)** 重新安装 APK，或通过活动启动器打开原生应用信息页。*
3. **正式开启两大核心权限**：
   - 返回 **无障碍 → 已下载的应用 → 开启 CodePlant Portal**。
   - 返回 **隐私/权限 → 特殊权限 → 通知使用权 → 开启 CodePlant Portal**（用于微信消息监听）。
   - 开启 **悬浮窗权限** 与 **通知权限**（用于督促提醒和二次确认弹窗）。

---

## 三、第三步：HyperOS 防杀后台 / 防掉无障碍黄金配置（解决 `dsh-Go` 半路掉权痛点）

**CodePlant Portal** 与 **Termux** 两款应用都必须做满以下 5 项：

1. **省电策略**：应用信息 → 省电策略 → 改为 **「无限制」**。
2. **自启动**：应用信息（或手机管家 → 应用管理 → 权限 → 自启动）→ **开启自启动**。
3. **后台弹出界面**：权限管理 → **允许「后台弹出界面」**（防止从通知/后台打开目标 App 被系统静默拦截）。
4. **多任务锁卡**：打开最近任务界面，长按 **CodePlant Portal** 和 **Termux** 卡片，点 **锁头图标 🔒**。
5. **Termux 唤醒锁**：进入 Termux 后在通知栏下拉菜单中点 **Acquire wakelock**（或脚本中执行 `termux-wake-lock`），防止息屏后定时督促和微信 Webhook 停摆。

---

## 四、第四步：Shizuku 无线调试配置（不依赖「USB 调试（安全设置）」）

1. 打开 **设置 → 我的设备 → 全部参数与信息**，连续点击 **OS 版本** 7 次开启开发者模式。
2. 进入 **设置 → 更多设置 → 开发者选项**：
   - 打开 **无线调试**（Wi-Fi 环境下即可配对）。
   - 打开 **停用 ADB 授权超时**（若有该选项）。
   - **重要**：**不要关闭「开发者选项」或「USB 调试」总开关**（即便用无线调试，关闭它们也会导致 Shizuku 立刻掉线）。
3. 打开 Shizuku → **通过无线调试启动 → 配对**，填入无线调试页面的 6 位配对码后启动。
4. 启动后打开 **CodePlant Portal** 主页点「请求 Shizuku 授权」→ **始终允许**（只需一次）。

> **已知能力边界实测说明**：
> - 未开「USB 调试（安全设置）」时，Shizuku **可以**静默 `screencap -p` 截屏、运行 `uiautomator dump`、查看前后台包名；
> - Shizuku **不可以**执行 `input tap` 或 `pm grant WRITE_SECURE_SETTINGS`（HyperOS 会报 `SecurityException`）。因此 Portal APK 默认将触控和文本输入全部走 **无障碍通道**，只有截屏优先走 Shizuku 免弹窗。
> - **手机重启后** Android 会自动关闭无线调试，重启后需重新打开一次无线调试点启动 Shizuku（若懒得开，Portal APK 在**纯无障碍模式**下依然可以照常完成点击、滑动、输入与控件树读取，仅截屏退回系统截屏/提示）。
