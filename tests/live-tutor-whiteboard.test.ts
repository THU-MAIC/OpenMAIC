import { describe, expect, it } from 'vitest';
import type { ModelSettingsView } from '@/lib/model-settings/client';
import { getCameraTutorCapabilities } from '@/lib/live-tutor/model-capabilities';
import {
  applyWhiteboardOps,
  buildWhiteboardFromSteps,
  renderSafeLatexHtml,
  sanitizeLiveCaption,
  sanitizeSvgDiagram,
} from '@/lib/live-tutor/whiteboard-elements';

describe('live-tutor whiteboard projection', () => {
  it('applies heading, step, formula, and clear operations in order', () => {
    const first = applyWhiteboardOps(
      [],
      [
        { op: 'add_heading', content: 'Quadratic Equations' },
        { op: 'add_step', content: 'Subtract 5 from both sides' },
        { op: 'add_formula', content: 'x^2 + 4x = 12' },
      ],
    );

    expect(first).toHaveLength(3);
    expect(first[0].kind).toBe('heading');
    expect(first[1].kind).toBe('text');
    expect(first[2].kind).toBe('latex');

    const cleared = applyWhiteboardOps(first, [
      { op: 'clear' },
      { op: 'add_step', content: 'Fresh step' },
    ]);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].content).toBe('Fresh step');
  });

  it('builds a valid @openmaic/dsl Whiteboard with non-overlapping text and latex elements', () => {
    const steps = applyWhiteboardOps(
      [],
      [
        { op: 'add_heading', content: 'Pythagorean Theorem' },
        { op: 'add_formula', content: 'a^2 + b^2 = c^2' },
        { op: 'add_step', content: 'Substitute a = 3 and b = 4 into the equation.' },
      ],
    );

    const wb = buildWhiteboardFromSteps(steps, 'wb-test-1');
    expect(wb.id).toBe('wb-test-1');
    expect(wb.viewportSize).toBe(1000);
    expect(wb.elements).toHaveLength(3);
    expect(wb.elements[0].type).toBe('text');
    expect(wb.elements[1].type).toBe('latex');
    expect(wb.elements[2].type).toBe('text');
    expect(wb.elements[1].top).toBeGreaterThan(wb.elements[0].top);
    expect(wb.elements[2].top).toBeGreaterThan(wb.elements[1].top);
  });

  it('renders safe KaTeX HTML and escapes unsafe raw text', () => {
    const katexHtml = renderSafeLatexHtml('\\frac{1}{2}', false);
    expect(katexHtml).toContain('katex');

    const steps = applyWhiteboardOps([], [{ op: 'add_step', content: 'Check x < 5 & y > 2' }]);
    const wb = buildWhiteboardFromSteps(steps);
    const firstEl = wb.elements[0];
    expect(firstEl.type).toBe('text');
    if (firstEl.type === 'text') {
      expect(firstEl.content).toContain('&lt;');
      expect(firstEl.content).toContain('&amp;');
    }
  });

  it('sanitizes SVG diagrams and projects them as PPTImageElement on the whiteboard', () => {
    const dirty =
      '<svg onclick="alert(1)" viewBox="0 0 600 340"><script>alert(1)</script><polygon points="100,280 460,280 460,80" fill="#eef2ff" stroke="#4f46e5" stroke-width="3"/><text x="260" y="305">Base = 12</text></svg>';
    const clean = sanitizeSvgDiagram(dirty);
    expect(clean).not.toBeNull();
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('onclick');
    expect(clean).toContain('xmlns="http://www.w3.org/2000/svg"');

    const steps = applyWhiteboardOps(
      [],
      [{ op: 'add_diagram', content: dirty, caption: 'Right Triangle Diagram' }],
    );
    const wb = buildWhiteboardFromSteps(steps, 'wb-diag-1');
    expect(wb.elements).toHaveLength(2);
    expect(wb.elements[0].type).toBe('text');
    expect(wb.elements[1].type).toBe('image');
    if (wb.elements[1].type === 'image') {
      expect(wb.elements[1].src).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    }
  });

  it('strips raw SVG and XML markup from live tutor captions', () => {
    expect(
      sanitizeLiveCaption(
        'Here is your right triangle <svg viewBox="0 0 600 340"><polygon points="0,0 10,10"/></svg> on the board.',
      ),
    ).toBe('Here is your right triangle on the board.');

    expect(
      sanitizeLiveCaption('Look at the angle <polygon points="100,280 460,280" stroke="#4f46e5"'),
    ).toBe('Look at the angle');
  });

  it('keeps all generated elements within the declared 1000x562.5 whiteboard viewport', () => {
    const ops = [
      { op: 'add_heading' as const, content: 'Trigonometry Walkthrough' },
      ...Array.from({ length: 12 }, (_, idx) => ({
        op: 'add_step' as const,
        content: `Step ${idx + 1}: Check the ratio of opposite over hypotenuse for triangle ${idx + 1}.`,
      })),
      {
        op: 'add_diagram' as const,
        content:
          '<svg viewBox="0 0 600 340"><polygon points="100,280 460,280 460,80" fill="#eef2ff" stroke="#4f46e5"/></svg>',
        caption: 'Final Triangle',
      },
      { op: 'add_formula' as const, content: '\\sin(\\theta) = \\frac{3}{5}' },
    ];
    const steps = applyWhiteboardOps([], ops);
    const wb = buildWhiteboardFromSteps(steps, 'wb-bounded');
    const maxBoardHeight = wb.viewportSize * wb.viewportRatio;

    expect(wb.elements.length).toBeGreaterThan(0);
    for (const el of wb.elements) {
      expect(el.top).toBeGreaterThanOrEqual(0);
      if ('height' in el) {
        expect(el.top + el.height).toBeLessThanOrEqual(maxBoardHeight);
      }
    }
    const lastEl = wb.elements[wb.elements.length - 1];
    expect(lastEl.type).toBe('latex');
  });
});

describe('live-tutor model capabilities', () => {
  it('prefers catalogued model vision metadata over name heuristics', () => {
    const view = {
      providers: [
        {
          id: 'ollama',
          preset: 'ollama',
          presetName: 'Ollama',
          presetKind: 'single',
          source: 'deployment',
          capabilities: {
            chat: {
              models: [
                {
                  id: 'llama3.3',
                  name: 'Llama 3.3',
                  capabilities: { streaming: true, tools: true, vision: false },
                },
              ],
            },
          },
        },
      ],
      slots: [
        {
          slot: 'classroom',
          effective: { status: 'assigned', providerId: 'ollama', modelId: 'llama3.3' },
        },
      ],
    } as unknown as ModelSettingsView;

    const caps = getCameraTutorCapabilities(view);
    expect(caps.supportsLiveStreaming).toBe(false);
    expect(caps.supportsVision).toBe(false);
  });

  it('disables live streaming when a deployment Google provider uses a hidden custom baseUrl', () => {
    const view = {
      providers: [
        {
          id: 'google',
          preset: 'google',
          presetName: 'Google Gemini',
          presetKind: 'single',
          source: 'deployment',
          hasCustomBaseUrl: true,
          capabilities: {
            chat: {
              models: [
                {
                  id: 'gemini-2.5-flash',
                  name: 'Gemini 2.5 Flash',
                  capabilities: { streaming: true, tools: true, vision: true },
                },
              ],
            },
          },
        },
      ],
      slots: [
        {
          slot: 'classroom',
          effective: { status: 'assigned', providerId: 'google', modelId: 'gemini-2.5-flash' },
        },
      ],
    } as unknown as ModelSettingsView;

    const caps = getCameraTutorCapabilities(view);
    expect(caps.supportsLiveStreaming).toBe(false);
    expect(caps.supportsVision).toBe(true);
  });

  it('disables live streaming when a deployment Google provider excludes the Live model from its allowlist', () => {
    const view = {
      providers: [
        {
          id: 'google',
          preset: 'google',
          presetName: 'Google Gemini',
          presetKind: 'single',
          source: 'deployment',
          liveStreamingAuthorized: false,
          capabilities: {
            chat: {
              models: [
                {
                  id: 'gemini-2.5-flash',
                  name: 'Gemini 2.5 Flash',
                  capabilities: { streaming: true, tools: true, vision: true },
                },
              ],
            },
          },
        },
      ],
      slots: [
        {
          slot: 'classroom',
          effective: { status: 'assigned', providerId: 'google', modelId: 'gemini-2.5-flash' },
        },
      ],
    } as unknown as ModelSettingsView;

    const caps = getCameraTutorCapabilities(view);
    expect(caps.supportsLiveStreaming).toBe(false);
    expect(caps.supportsVision).toBe(true);
  });
});
