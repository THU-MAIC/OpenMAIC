#!/bin/bash
set -e

echo "🔐 OpenMAIC HTTPS 证书生成工具"
echo "=================================="

# 检测 mkcert 是否安装
if ! command -v mkcert &> /dev/null; then
    echo "❌ mkcert 未安装，请先安装 mkcert:"
    echo ""
    echo "   macOS:     brew install mkcert"
    echo "   Ubuntu/Debian: sudo apt install mkcert"
    echo "   CentOS/RHEL: 请参考 https://github.com/FiloSottile/mkcert#installation"
    echo "   Windows:    choco install mkcert 或者 scoop install mkcert"
    echo ""
    echo "安装后请运行: mkcert -install"
    exit 1
fi

echo "✅ mkcert 已检测到"

# 初始化本地 CA
echo "🔧 初始化本地 CA..."
mkcert -install

# 获取局域网 IP
echo "🌐 检测局域网 IP 地址..."
LAN_IPS=$(node "$(dirname "$0")/detect-lan-ip.js")
echo "📋 检测到内网 IP: $LAN_IPS"

# 构建域名列表
DOMAINS="localhost 127.0.0.1 $LAN_IPS"
echo "📋 将为以下域名生成证书: $DOMAINS"

# 生成证书到项目根目录
OUTPUT_DIR="$(dirname "$0")/.."
cd "$OUTPUT_DIR"

echo "🚀 生成证书..."
mkcert -cert-file localhost.crt -key-file localhost.key $DOMAINS

echo ""
echo "✅ 证书生成完成！"
echo "📍 证书位置: $(pwd)/localhost.crt"
echo "📍 私钥位置: $(pwd)/localhost.key"
echo ""
echo "📝 下一步操作:"
echo "   1. 编辑 .env 文件，添加 HTTPS_ENABLE=true"
echo "   2. 运行 pnpm dev 启动服务（同时启动 HTTP 和 HTTPS）"
echo "   3. 访问 https://localhost:3001 即可"
echo ""
echo "🌐 局域网访问地址:"
for ip in $LAN_IPS; do
    echo "   https://$ip:3001"
done
