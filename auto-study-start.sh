#!/bin/bash
# ============================================
# 杭州人社学习平台 - 自动刷课 v3 一键启动
# ============================================
# 修复：登录持久化 + 不弹页面 + 自动播放
# 
# 使用方式：
#   1. 打开终端 (Terminal)
#   2. 执行: bash ~/auto-study-project/auto-study-start.sh
#   3. 首次运行：浏览器弹出后手动登录，登录状态自动保存
#   4. 后续运行：自动恢复登录，无需重新登录
# ============================================

set -e

PROJECT_DIR="$HOME/auto-study-project"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   杭州人社学习平台 - 自动刷课 v3.6      ║"
echo "║   新增：已学课程去重，不再重复刷同一门课    ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# 1. 创建项目目录
mkdir -p "$PROJECT_DIR"

# 2. 安装依赖（如果还没有）
if [ ! -d "$PROJECT_DIR/node_modules/playwright" ]; then
  echo "[1/2] 安装依赖（首次运行，请稍候）..."
  cd "$PROJECT_DIR"
  npm init -y > /dev/null 2>&1
  npm install playwright > /dev/null 2>&1
  echo "[1/2] ✅ 依赖安装完成"
else
  echo "[1/2] ✅ 依赖已安装"
fi

# 3. 复制最新脚本
SCRIPT_SOURCE="/Users/gaobo/WorkBuddy/2026-06-05-09-39-05/auto-study-v3.js"
if [ -f "$SCRIPT_SOURCE" ]; then
  cp "$SCRIPT_SOURCE" "$PROJECT_DIR/auto-study.js"
  echo "[2/2] ✅ 脚本已更新 (v3.6)"
else
  echo "[2/2] ⚠️  未找到源脚本，使用本地版本"
fi

echo ""
echo "🚀 启动自动学习..."
echo "   📝 日志文件: $PROJECT_DIR/auto-study.log"
echo "   💾 浏览器数据: $PROJECT_DIR/browser-data/"
echo "   按 Ctrl+C 可随时停止"
echo ""

cd "$PROJECT_DIR"
node auto-study.js
