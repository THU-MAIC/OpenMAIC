#!/usr/bin/env node
// Load environment variables from .env
require('dotenv').config();

const { createServer } = require('http');
const { createServer: createHttpsServer } = require('https');
const { readFileSync } = require('fs');
const { parse } = require('url');
const next = require('next');

// 读取环境变量配置
const dev = process.env.NODE_ENV !== 'production';
const httpsEnabled = process.env.HTTPS_ENABLE === 'true' || process.env.HTTPS_ENABLE === '1';
const httpPort = parseInt(process.env.HTTP_PORT || '3000', 10);
const httpsPort = parseInt(process.env.HTTPS_PORT || '3001', 10);
const host = process.env.HOST || '0.0.0.0';
const certPath = process.env.HTTPS_CERT_PATH || './localhost.crt';
const keyPath = process.env.HTTPS_KEY_PATH || './localhost.key';

// 初始化 Next.js
const app = next({ dev, hostname: host, port: httpPort });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  // 始终启动 HTTP 服务器
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  httpServer.listen(httpPort, host, () => {
    console.log(`✅ HTTP 服务器已启动`);
    console.log(`📍 本地访问: http://localhost:${httpPort}`);
    console.log(`📍 局域网访问: http://${host === '0.0.0.0' ? 'your-lan-ip' : host}:${httpPort}`);
    console.log('');
  });

  // 如果启用 HTTPS，则启动 HTTPS 服务器
  if (httpsEnabled) {
    try {
      // 检查证书文件是否存在
      const cert = readFileSync(certPath);
      const key = readFileSync(keyPath);

      const httpsServer = createHttpsServer({ cert, key }, (req, res) => {
        const parsedUrl = parse(req.url, true);
        handle(req, res, parsedUrl);
      });

      httpsServer.listen(httpsPort, host, () => {
        console.log(`🔐 HTTPS 服务器已启动`);
        console.log(`📍 本地访问: https://localhost:${httpsPort}`);
        console.log(`📍 局域网访问: https://${host === '0.0.0.0' ? 'your-lan-ip' : host}:${httpsPort}`);
        console.log('');
        console.log(`📝 提示: 如果浏览器提示不安全，请确保已运行 mkcert -install 信任本地 CA`);
        console.log('');
      });

    } catch (err) {
      console.error(`❌ HTTPS 证书文件读取失败`);
      console.error(`   证书路径: ${certPath}`);
      console.error(`   私钥路径: ${keyPath}`);
      console.error('');
      console.error(`👉 请先运行: ./scripts/setup-https.sh 生成证书`);
      console.error('');
      console.error(`👉 如果证书位置自定义，请在 .env 文件中设置 HTTPS_CERT_PATH 和 HTTPS_KEY_PATH`);
      console.error('');
      process.exit(1);
    }
  } else {
    console.log(`ℹ️  HTTPS 未启用 (设置 HTTPS_ENABLE=true 启用)`);
    console.log('');
  }
}).catch(err => {
  console.error('❌ 启动失败:', err);
  process.exit(1);
});
