import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

// Only the isolated Playwright app uses this deterministic model transport.
const modelServer = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const user = body.messages?.find((message) => message.role === 'user');
    const prompt =
      typeof user?.content === 'string'
        ? user.content
        : user?.content?.find((part) => part.type === 'text')?.text;
    const line = prompt?.split('\n').find((item) => item.startsWith('{"workKind":'));
    const input = JSON.parse(line);
    if (input.teacherNotes === 'FICTIONAL_PROVIDER_FAILURE') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Fictional provider unavailable' } }));
      return;
    }
    const source = input.sources.find((item) => item.role === 'student_work');
    const block = source.blocks[0];
    const content = JSON.stringify({
      readiness: 'insufficient',
      observations: [
        {
          category: 'needs_verification',
          text: '虚构验收：答卷记录了方程求解过程，独立作答情况仍待核对。',
          citations: [
            { sourceId: source.sourceId, blockId: block.blockId, quote: block.text.slice(0, 100) },
          ],
        },
      ],
      recommendations: [
        { text: '下次请学生解释一次移项过程，并记录是否使用提示。', observationIndexes: [0] },
      ],
      limitations: ['此输出仅为流程测试用的固定模型响应。'],
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'fictional-completion',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      }),
    );
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid fictional model request' } }));
  }
});
await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
const port = modelServer.address().port;
const child = spawn(
  process.execPath,
  ['node_modules/next/dist/bin/next', 'start', '-p', '3001', '-H', '127.0.0.1'],
  {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      OPENAI_API_KEY: 'fictional-local-test-key',
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OPENAI_MODELS: 'gpt-4o-mini',
      DEFAULT_MODEL: 'openai:gpt-4o-mini',
      MODEL_ROUTES: JSON.stringify({ 'teacher-student-analysis': 'openai:gpt-4o-mini' }),
    },
  },
);
function stop() {
  child.kill();
  modelServer.close();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.once('exit', (code) => {
  modelServer.close();
  process.exitCode = code ?? 0;
});
