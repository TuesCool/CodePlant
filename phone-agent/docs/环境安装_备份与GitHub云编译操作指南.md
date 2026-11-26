# 🧰 环境安装、备份、Git 推送与云编译 APK 操作教程

> **适用对象**：零基础快速上手并理解每一步原理，所有工具均采用**绿色便携安装 + 原始压缩包备份**，**未修改 Windows 系统注册表或全局 PATH**。

---

## 一、已安装环境与备份位置总览（`Z:\SOFTWARE\Install package`）

| 软件名称 | 版本 | 实际安装目录（免安装绿色版） | 备份安装包路径 | 用途 |
| :--- | :--- | :--- | :--- | :--- |
| **Git** *(原有)* | `2.56.1` | `Z:\SOFTWARE\Install package\Git\PortableGit\` | `Z:\SOFTWARE\Install package\Git\安装包_Installer\` | 代码版本管理与推送 |
| **NodeJS** *(新建)* | `v22.23.5` (npm `10.9.9`) | `Z:\SOFTWARE\Install package\NodeJS\node-v22.23.5-win-x64\` | `Z:\SOFTWARE\Install package\NodeJS\安装包_Backup\node-v22.23.5-win-x64.zip` | 在电脑端校验 `pi-server` 依赖与 TypeScript 编译 |
| **GitHubCLI (`gh`)** *(新建)* | `v2.106.0` | `Z:\SOFTWARE\Install package\GitHubCLI\` | `Z:\SOFTWARE\Install package\GitHubCLI\安装包_Backup\gh_2.106.0_windows_amd64.zip` | 浏览器一键登录 GitHub、配置 Git 凭据、查看 Actions |

> 💡 **PowerShell 小贴士**：本机 PowerShell 默认禁用未签名 `.ps1` 脚本，因此直接运行 `npm` 会提示无法加载 `npm.ps1`。解决方式：在 PowerShell 中调用 **`npm.cmd`**（例如 `& "Z:\SOFTWARE\Install package\NodeJS\node-v22.23.5-win-x64\npm.cmd" run typecheck`），或者使用 Git Bash / CMD。

---

## 二、为什么还差“一键登录并推送”这一步？

在本地我们已将 `TuesCool/CodePlant` 克隆到 [`_codeplant_repo`](file:///Z:/D/桌面/Agent/Demand/phone%20agent/_codeplant_repo)，并把全部规划文档、`pi-server`、`android-portal` 与根工作流 `.github/workflows/build-portal-apk.yml` 整理完毕，生成了本地提交 `eaa0282`。

但由于这台电脑此前**没有保存任何 GitHub 账号凭据或 SSH 密钥**（`gh auth status` 返回未登录），AI 无法替你输入账号密码。你只需完成一次浏览器扫码/授权登录即可推送成功。

---

## 三、两种执行方式（推荐方式 A 一键完成，方式 B 用于学习命令原理）

### 方式 A：直接运行一键同步推送脚本（最省心）

在 PowerShell 中执行（首次会弹出浏览器让你登录 `TuesCool` 的 GitHub 账号）：

```powershell
powershell -ExecutionPolicy Bypass -File "Z:\D\桌面\Agent\Demand\phone agent\SYNC_AND_PUSH.ps1"
```

后续你每次修改完 [`phone agent`](file:///Z:/D/桌面/Agent/Demand/phone%20agent) 里的代码，只需再运行一次这条命令，输入提交说明回车，就会自动同步并推送到 `TuesCool/CodePlant`。

---

### 方式 B：手动逐条执行命令（推荐用来学习 Git / GitHub 工作流）

#### 第 1 步：临时把便携工具加入当前终端（只对当前窗口生效）
```powershell
$env:PATH = "Z:\SOFTWARE\Install package\Git\PortableGit\cmd;Z:\SOFTWARE\Install package\NodeJS\node-v22.23.5-win-x64;Z:\SOFTWARE\Install package\GitHubCLI\bin;$env:PATH"
```

#### 第 2 步：用 GitHub CLI 登录并绑定 Git 凭据（只需做一次）
```powershell
gh auth login -h github.com -p https -w
gh auth setup-git
```
*命令含义*：`-h github.com` 指定 GitHub，`-p https` 走 HTTPS 协议，`-w` 打开网页授权；输入屏幕上的 8 位一次性验证码即可完成登录。

#### 第 3 步：推送已准备好的本地提交到 `TuesCool/CodePlant`
```powershell
cd "Z:\D\桌面\Agent\Demand\phone agent\_codeplant_repo"
git status
git push -u origin main
```
*命令含义*：`origin` 是远程仓库地址（`https://github.com/TuesCool/CodePlant.git`），`main` 是主分支，`-u` 会记住默认上游分支，以后直接 `git push` 即可。

#### 第 4 步：日常修改后再提交（学习标准三步曲）
```powershell
# 1. 若修改了 pi-server，先在电脑端检查 TS 类型有没有写错：
cd "Z:\D\桌面\Agent\Demand\phone agent\pi-server"
npm.cmd run typecheck

# 2. 同步改动到仓库目录后提交推送：
cd "Z:\D\桌面\Agent\Demand\phone agent\_codeplant_repo"
git add -A
git commit -m "feat: 你的改动说明"
git push
```

---

## 四、GitHub Actions 云编译 & 下载 APK 到小米 14

1. 推送成功后，用浏览器打开：`https://github.com/TuesCool/CodePlant/actions`
2. 看到 **`Build CodePlant Phone Agent (APK + Pi Server Check)`** 正在运行（约 2~4 分钟）：
   - `check-pi-server`：自动检查 TypeScript 编译；
   - `build-portal-apk`：云端自动配置 JDK 17 + Android SDK + Gradle 8.11.1 编译 `app-debug.apk`。
3. 变成绿色 ✅ 后点进去，拉到页面最下方 **Artifacts**，下载 **`codeplant-portal-debug-apk`**，解压出 `app-debug.apk` 发到小米 14 安装。
4. 安装与权限配置严格按 [`MI14_HyperOS_无Root无安全调试实操清单.md`](./MI14_HyperOS_无Root无安全调试实操清单.md) 操作即可。
