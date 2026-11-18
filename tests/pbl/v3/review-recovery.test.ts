import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { deliveredReviewResponse } from '@/lib/server/pbl-v3/review-question';

const suffix = '\n</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
const reply = 'A returned value can be saved by the caller.\n\nWhich value is returned?';

describe('displayed review recovery', () => {
  it.each(['', '\n'])(
    'retains a paired bold question before an attached suffix (%j)',
    (separator) => {
      const response =
        'Saving a return value lets the caller reuse it.\n\n**Which operation keeps the returned value？**';
      expect(deliveredReviewResponse(response + separator + suffix.slice(1))).toBe(response);
    },
  );
  it('retains the complete original explanation, code and question', () => {
    const response =
      'The caller keeps the result.\n\n```python\nvalue = greet(name)\n```\n\nWhich value is returned?';
    expect(deliveredReviewResponse(response + suffix)).toBe(response);
    expect(deliveredReviewResponse((response + suffix).replaceAll('\n', '\r\n'))).toBe(
      response.replaceAll('\n', '\r\n'),
    );
  });

  it.each([
    'Which value is returned? Please explain why.',
    'Which value is returned？Please explain why。',
    'Which value is returned? Please explain why!',
    'Which value is returned？Please explain why！',
  ])('retains a complete bold question and response instruction: %s', (closing) => {
    const response = 'The caller can keep the result.\n\n**' + closing + '**';
    expect(deliveredReviewResponse(response + suffix.slice(1))).toBe(response);
  });

  it.each([
    reply,
    reply + suffix.replaceAll('｜｜', '｜'),
    reply + suffix.replace(' parameter>', ' parameters>'),
    reply + suffix + '\nMore content.',
    'Which value is returned?' + suffix,
    'An explanation.\n\nNo closing question.' + suffix,
    'An explanation.\n\nExplain the returned value!' + suffix,
    'Can the caller save it?\n\nThis is an explanation.' + suffix,
    'An explanation.\n\nWhich value is returned? Please explain why' + suffix,
    'An explanation.\n\n**Which value is returned? Please explain why**' + suffix,
    'An explanation.\n\nWhich value is returned? Please explain why;' + suffix,
    'An explanation.\n\nWhich value is returned? Please explain why:' + suffix,
    'An explanation.\n\n**Which value is returned?' + suffix,
    'An explanation.\n\nWhich value is returned?**' + suffix,
    'An explanation.\n\n```xml\n' + reply + suffix,
    'An explanation.\n\n~~~xml\n' + reply + suffix,
    reply + '\n```xml' + suffix + '\n```',
    reply + suffix + '\n\n' + reply + suffix,
    'An explanation containing <｜DSML｜invoke>.\n\nWhich value is returned?' + suffix,
  ])('does not infer a recovery receipt from ambiguous or intentional markup: %s', (text) => {
    expect(deliveredReviewResponse(text)).toBeNull();
  });
});
