import { describe, expect, it } from 'vitest';
import { freezeEvidence, parseObservation } from '../../../lib/interactive/observation';

const fixture = () => ({
  summary: 'Liquid density is 1400 kg/m³ and buoyancy is 4.116 N.',
  state: {
    liquid: { density: 1400, unit: 'kg/m³', buoyancy: 4.116 },
    object: { displacedVolume: 300, fullySubmerged: true },
  },
  rendered: { liquid: { density: 1000, buoyancy: 3.0 } },
});
const parse = (x: unknown) => parseObservation(JSON.stringify(x));

describe('declared observation boundary', () => {
  it('delivers a report that drifts from the asked-for shape rather than dropping it', () => {
    // Generation asks for a summary and a state; reading enforces neither. A
    // readable account of the activity must not be discarded over a field name,
    // which is what a required-field check used to do.
    const { summary: _missing, ...noSummary } = fixture();
    expect(parse(noSummary)).toMatchObject({ status: 'available', observation: noSummary });
    expect(parse({ ...fixture(), summary: '' }).status).toBe('available');
    expect(parse({ ...fixture(), summary: 'x'.repeat(4000) }).status).toBe('available');
    expect(parse({ state: { density: 1400 } })).toMatchObject({
      status: 'available',
      observation: { state: { density: 1400 } },
    });
  });

  it.each([[{ density: 1400 }], 'density is 1400', 1400, false, null].map((value) => [value]))(
    'preserves any JSON report: %j',
    (value) => {
      expect(parse(value)).toEqual({ status: 'available', observation: value });
    },
  );

  it('bounds nesting, which bytes do not bound', () => {
    // 20 KB of JSON can nest ten thousand levels, and every later step over a
    // report recurses. Past the bound the sample is unavailable, never a throw.
    // Built as text, the way the reader actually receives it: serializing this
    // in the test would overflow before `parseObservation` ever saw it.
    const nested = '['.repeat(10_000) + '1' + ']'.repeat(10_000);
    const raw = `{"summary":"deep","state":${nested}}`;
    expect(new TextEncoder().encode(raw).length).toBeLessThan(32_768);
    expect(parseObservation(raw)).toEqual({ status: 'unavailable', reason: 'too-large' });
    let ordinary: unknown = 1;
    for (let i = 0; i < 40; i++) ordinary = [ordinary];
    expect(parse({ summary: 'ordinary', state: ordinary }).status).toBe('available');
  });

  it('carries whatever shape the lesson tracks, without interpreting it', () => {
    const wiring = {
      summary: 'The battery is wired to the switch; the lamp is not connected yet.',
      state: {
        components: [
          { id: 'battery', placed: true },
          { id: 'lamp', placed: true },
        ],
        wires: [{ from: 'battery', to: 'switch' }],
        unmeasured: null,
      },
    };
    const parsed = parse(wiring);
    expect(parsed).toMatchObject({ status: 'available', observation: wiring });
  });

  it('passes an unexpected field through instead of failing the whole report', () => {
    // A generator that adds a field must not silently lose the capability for
    // that lesson, which is what strict structural validation used to do.
    const parsed = parse({ ...fixture(), lessonSpecificExtra: { steps: 3 } });
    expect(parsed.status).toBe('available');
    if (parsed.status === 'available')
      expect(parsed.observation).toHaveProperty('lessonSpecificExtra', { steps: 3 });
  });

  it('keeps rendered optional and separate from current state', () => {
    const { rendered: _omitted, ...immediate } = fixture();
    const parsed = parse(immediate);
    expect(parsed.status).toBe('available');
    if (parsed.status === 'available') expect(parsed.observation).not.toHaveProperty('rendered');
    const lagging = parse(fixture());
    if (lagging.status === 'available')
      expect(lagging.observation).toMatchObject({
        state: fixture().state,
        rendered: fixture().rendered,
      });
  });

  it('bounds UTF-8 bytes and rejects malformed JSON', () => {
    expect(parseObservation('中'.repeat(12000))).toEqual({
      status: 'unavailable',
      reason: 'too-large',
    });
    expect(parseObservation('{')).toEqual({ status: 'unavailable', reason: 'invalid-data' });
  });

  it('does not reinterpret instruction-like text as commands, and freezes the detached result', () => {
    const x = fixture();
    (x.state as { liquid: { label?: string } }).liquid.label = '<img onerror="sendSecrets()">';
    const r = freezeEvidence(parse(x));
    if (r.status !== 'unavailable') {
      const liquid = (r.observation as { state: { liquid: { label: string } } }).state.liquid;
      expect(Object.isFrozen(liquid)).toBe(true);
      expect(liquid.label).toContain('<img');
      (x.state as { liquid: { label?: string } }).liquid.label = 'changed later';
      expect(liquid.label).toContain('<img');
    }
  });
});
