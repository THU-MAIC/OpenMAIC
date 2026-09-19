import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const promptPath = 'eval/pbl-v2-planner/judge-prompt-completability.md';

function prompt(): string {
  return readFileSync(promptPath, 'utf-8');
}

describe('PBL v2 completability judge prompt', () => {
  it('locks ordinary PBL to visible text and the actual runtime surface', () => {
    const text = prompt();

    expect(text).toContain('Ordinary PBL runtime');
    expect(text).toContain('left roadmap');
    expect(text).toContain('center Instructor chat');
    expect(text).toContain('right submission panel');
    expect(text).toContain('does **NOT** have a right-side briefing tab');
    expect(text).toContain('preloaded image');
    expect(text).toContain('attached PDF');
    expect(text).toContain('provided dataset');
    expect(text).toContain('visible milestone/task/instructor text');
  });

  it('allows scenario briefing only for scenario runtime and requires advanceable beats', () => {
    const text = prompt();

    expect(text).toContain('Scenario PBL runtime');
    expect(text).toContain('prep: Instructor explains the premise and rules');
    expect(text).toContain('one or more roleplay stages');
    expect(text).toContain('wrapup: Instructor consolidates what happened');
    expect(text).toContain('Scenario projects may use the scenario briefing panel after prep');
    expect(text).toContain('concrete observable `successWhen`');
  });

  it('uses an explicit blocker taxonomy for impossible generated projects', () => {
    const text = prompt();

    for (const code of [
      'C1 hidden-unavailable-resource',
      'C2 missing-prerequisite-material',
      'C3 unclear-done-evidence-path',
      'C4 unavailable-platform-capability',
      'C5 impossible-ordering',
      'C6 scope-too-large',
      'C7 scenario-cannot-advance',
      'C8 private-unseen-info-required',
    ]) {
      expect(text).toContain(code);
    }
  });

  it('requires semantic cross-language judgment for implied but absent materials', () => {
    const text = prompt();

    expect(text).toContain('Judge this semantically across languages');
    expect(text).toContain('not by matching those example phrases');
    expect(text).toContain('read/inspect/analyze a brief');
    expect(text).toContain('the actual content needed for the task is present');
    expect(text).toContain('the actual content is not visible in the project text');
    expect(text).toContain('extract facts from a brief/case/material');
  });

  it('requires strict JSON with pass, blockers, risk level and rationale', () => {
    const text = prompt();

    expect(text).toContain('Output **exactly one JSON object**');
    expect(text).toContain('"score": <1-5>');
    expect(text).toContain('"pass": <true|false>');
    expect(text).toContain('"blockers": ["C1 hidden-unavailable-resource"]');
    expect(text).toContain('"riskLevel": "low" | "medium" | "high"');
    expect(text).toContain('"rationale"');
    expect(text).toContain('Set `pass=true` only when the score is 4 or 5 and `blockers` is empty');
  });
});
