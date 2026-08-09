#!/usr/bin/env tsx
/**
 * 测试 pptxtojson-pro（本库）：直接 import src 源码，无需打包。
 * 用法: npx tsx scripts/transvert.ts <path-to.pptx> [output.json]
 * 或:   pnpm run transvert:pro <path-to.pptx> [output.json]
 */

import { parseZip } from '../src/parser/ZipParser';
import { buildPresentation } from '../src/model/Presentation';
import { toPptxtojsonFormat } from '../src/adapter/toPptxtojson';
import fs from 'fs';
import path from 'path';

const pptxPath = process.argv[2];
const outputPath = process.argv[3];

if (!pptxPath) {
  console.error('用法: npx tsx scripts/transvert.ts <path-to.pptx> [output.json]');
  process.exit(1);
}

const resolved = path.resolve(process.cwd(), pptxPath);
if (!fs.existsSync(resolved)) {
  console.error('文件不存在:', resolved);
  process.exit(1);
}

async function main() {
  const buf = fs.readFileSync(resolved);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const files = await parseZip(arrayBuffer);
  const presentation = buildPresentation(files);
  const json = await toPptxtojsonFormat(presentation, files, 'blob');

  const text = JSON.stringify(json, null, 2);

  if (outputPath) {
    const outResolved = path.resolve(process.cwd(), outputPath);
    fs.writeFileSync(outResolved, text, 'utf-8');
    console.log(`输出已写入: ${outResolved} (${(text.length / 1024).toFixed(1)} KB)`);
  } else {
    console.log(text);
  }
}

main().catch((err) => {
  console.error('解析失败:', err);
  process.exit(1);
});
