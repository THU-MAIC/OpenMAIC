import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps a plain Node parent alive after oversized plan and rewrite requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openmaic-parser-parent-'));
  try {
    // Transpile the actual scheduler, not a test implementation. The child runs
    // plain Node without Vitest transforms or mocks; only the local TS import
    // extension changes. Standalone entry chunks are verified separately.
    for (const name of ['errors', 'document-image-parser']) {
      const source = await readFile(`lib/server/material-extraction/${name}.ts`, 'utf8');
      const compiled = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      }).outputText;
      await writeFile(
        join(directory, `${name}.mjs`),
        compiled.replace("from './errors'", "from './errors.mjs'"),
      );
    }
    const script = `
      import assert from 'node:assert/strict';
      import { runDocumentImageWorker, DocumentImageParseError } from ${JSON.stringify(pathToFileURL(join(directory, 'document-image-parser.mjs')).href)};
      const index = { exact: new Map([['images/fig.png', 'img-1']]), byBasename: new Map([['fig.png', 'img-1']]) };
      let rejected = 0;
      for (const repetitions of [50001, 500000, 600000, 700000]) {
        const text = '<span>x</span>'.repeat(repetitions);
        for (const kind of ['plan', 'rewrite']) {
          for (let attempt = 0; attempt < 3; attempt++) {
            const job = kind === 'plan' ? {kind, text} : {kind, blocks: [{type: 'markdown', text}], index};
            await assert.rejects(runDocumentImageWorker(job), error =>
              error instanceof DocumentImageParseError && !error.retryable && /input exceeds/.test(error.message));
            rejected++;
          }
        }
      }
      // Both real worker operations still work in this same surviving parent.
      const text = '![x](images/fig.png)';
      const written = await runDocumentImageWorker({kind: 'rewrite', blocks: [{type:'markdown', text}], index});
      assert.equal(written.text, '![x](openmaic-derivative:img-1)');
      const planned = await runDocumentImageWorker({kind:'plan', text:written.text});
      assert.equal(planned.markdown.length, 1);
      console.log(JSON.stringify({node: process.version, rejected, recovered: true}));
    `;
    const probe = join(directory, 'probe.mjs');
    await writeFile(probe, script);
    const result = await promisify(execFile)(process.execPath, [probe], {
      cwd: process.cwd(),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.stderr).not.toContain('FATAL ERROR');
    expect(JSON.parse(result.stdout.trim())).toEqual({
      node: process.version,
      rejected: 24,
      recovered: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 65_000);
