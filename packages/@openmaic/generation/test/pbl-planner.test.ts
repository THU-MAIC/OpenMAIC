import { readFileSync } from 'node:fs';
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
  it('keeps the app compatibility barrel on the package function', async () => {
    const input = pblPlannerInput();
    const response = validPBLResponse();
    const appBarrel = readFileSync(
      new URL('../../../../lib/pbl/v2/agents/planner-single-call.ts', import.meta.url),
      'utf8',
    );
    expect(appBarrel).toContain(
      "export { generatePBLV2ProjectSingleCall } from '@openmaic/generation';",
    );
    await expect(
      generatePBLV2ProjectSingleCall(input, async () => response),
    ).resolves.toMatchObject({
      title: 'CSV Data Analyzer project',
      status: 'active',
    });
  });
});
