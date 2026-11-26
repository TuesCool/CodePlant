#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

echo "=== CodePlant Phone Agent - Termux M0 初始化 ==="
pkg update -y
pkg install -y nodejs-lts git

# 申请 Termux 唤醒锁，避免息屏被 HyperOS 冻结定时督促与 Webhook
termux-wake-lock || true

if [ ! -f ".env" ] && [ -f ".env.example" ]; then
  cp .env.example .env
  echo "已生成默认 .env，请按需核对 PORTAL_TOKEN。"
fi

npm install
echo "初始化完成！执行以下命令启动服务："
echo "  npm start"
echo "随后手机浏览器访问: http://127.0.0.1:8787"
