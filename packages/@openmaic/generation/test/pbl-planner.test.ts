import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { generatePBLV2ProjectSingleCall, type AICallFn } from '@openmaic/generation';
import { pblPlannerInput, validPBLResponse } from './scene-fixtures.js';

describe('re-seated PBL single-call planner', () => {
  it('hydrates and normalizes a project from a canned AICallFn response', async () => {
    const aiCall: AICallFn = vi.fn(async () => validPBLResponse());
    const project = await generatePBLV2ProjectSingleCall(pblPlannerInput(), aiCall);

    expect(project).toMatchObject({
      title: 'CSV Data Analyzer project',
      status: 'active',
      uiPhase: 'hero',
      language: 'en-US',
    });
    expect(project.roles[0]).toMatchObject({ type: 'instructor', name: 'CSV Analysis Coach' });
    expect(project.roles[0].id).toMatch(/^role_/);
    expect(project.milestones[0].status).toBe('active');
    expect(project.milestones[0].microtasks[0].status).toBe('in_progress');
    expect(project.threads[0].agentId).toBe(project.roles[0].id);
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it('retries once with concrete validation gaps', async () => {
    const invalid = JSON.stringify({ projectInfo: {}, instructorRole: {}, milestones: [] });
    const aiCall = vi
      .fn<AICallFn>()
      .mockResolvedValueOnce(invalid)
      .mockResolvedValueOnce(validPBLResponse());

    const project = await generatePBLV2ProjectSingleCall(pblPlannerInput(), aiCall);
    expect(project.title).toBe('CSV Data Analyzer project');
    expect(aiCall).toHaveBeenCalledTimes(2);
    expect(aiCall.mock.calls[1][1]).toContain('Your previous output had these problems:');
  });
});

describe('PBL planner re-seat proof', () => {
  it('produces the same normalized project through app and package call seams', () => {
    const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const input = pblPlannerInput();
    const response = validPBLResponse();
    const program = `
      import assert from 'node:assert/strict';
      import { generatePBLV2ProjectSingleCall as packageGenerate } from './packages/@openmaic/generation/src/index.ts';

      const appModule = await import('./lib/pbl/v2/agents/planner-single-call.ts');
      const appGenerate = appModule.generatePBLV2ProjectSingleCall ?? appModule.default?.generatePBLV2ProjectSingleCall;
      assert.equal(typeof appGenerate, 'function');

      const input = ${JSON.stringify(input)};
      const response = ${JSON.stringify(response)};
      const appProject = await appGenerate(
        input,
        { provider: 'proof', modelId: 'proof' },
        async () => ({ text: response }),
      );
      const packageProject = await packageGenerate(input, async () => response);

      function canonicalize(root) {
        const ids = new Map();
        let nextId = 1;
        const visit = (value, key = '') => {
          if (Array.isArray(value)) return value.map((entry) => visit(entry));
          if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, visit(entry, name)]));
          }
          if (typeof value === 'string') {
            if (key === 'id' || key === 'agentId' || key.endsWith('Id')) {
              if (!ids.has(value)) ids.set(value, '<id-' + nextId++ + '>');
              return ids.get(value);
            }
            if (key === 'ts' || key.endsWith('At')) return '<timestamp>';
          }
          return value;
        };
        return visit(root);
      }

      assert.deepEqual(canonicalize(packageProject), canonicalize(appProject));
      console.log(JSON.stringify({ equal: true, normalization: 'ids-and-timestamps' }));
    `;

    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', program],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
    expect(JSON.parse(output.trim().split('\n').at(-1) ?? '{}')).toEqual({
      equal: true,
      normalization: 'ids-and-timestamps',
    });
  });
});
