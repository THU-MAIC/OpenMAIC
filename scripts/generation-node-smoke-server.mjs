#!/usr/bin/env node

import { createServer } from 'node:http';

function readPort(argv) {
  if (argv.length !== 2 || argv[0] !== '--port' || !/^\d+$/.test(argv[1])) {
    throw new Error('Usage: node generation-node-smoke-server.mjs --port <port>');
  }
  const port = Number(argv[1]);
  if (port < 1 || port > 65_535) throw new Error(`Invalid port: ${argv[1]}`);
  return port;
}

const port = readPort(process.argv.slice(2));
const outlinePayload = JSON.stringify({
  languageDirective: 'Teach in English with concise explanations.',
  courseTitle: 'Node Smoke Course',
  outlines: [
    {
      id: 'scene_1',
      type: 'slide',
      title: 'Smoke-Test Outline',
      description: 'Confirms outline generation through an OpenAI-compatible endpoint.',
      keyPoints: ['Package import', 'HTTP model seam', 'Outline validation'],
      order: 1,
    },
  ],
});

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
    return;
  }
  if (request.method !== 'POST' || request.url !== '/chat/completions') {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    try {
      const payload = JSON.parse(body);
      if (!payload.model || !Array.isArray(payload.messages)) {
        throw new Error('model and messages are required');
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-generation-smoke',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: outlinePayload } }],
        }),
      );
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Generation smoke server listening on http://127.0.0.1:${port}`);
});

const close = () => server.close(() => process.exit(0));
process.on('SIGINT', close);
process.on('SIGTERM', close);
