import { describe, expect, it } from 'vitest';
import {
  EDITABLE_ELEMENT_ID_PREFIX,
  MAIC_ELEMENT_ID_ATTRIBUTE,
  SCREEN_ELEMENT_ID_PREFIX,
  editableElementDomId,
  maicElementIdAttributes,
  screenElementDomId,
} from '@/components/edit/surfaces/slide/renderer-element-dom';
import { INTERACTION_ELEMENT_ID_ATTRIBUTES } from '@/components/edit/surfaces/slide/element-hit-test';

describe('renderer editor DOM contract', () => {
  it('uses the same stable id format consumed by timeline pick and teaching effects', () => {
    expect(EDITABLE_ELEMENT_ID_PREFIX).toBe('editable-element-');
    expect(editableElementDomId('title-1')).toBe('editable-element-title-1');
  });

  it('shares playback host ids with overlays', () => {
    expect(SCREEN_ELEMENT_ID_PREFIX).toBe('screen-element-');
    expect(screenElementDomId('title-1')).toBe('screen-element-title-1');
  });

  it('stamps the renderer-agnostic pick attribute accepted by hit-testing', () => {
    expect(MAIC_ELEMENT_ID_ATTRIBUTE).toBe('data-maic-element-id');
    expect(maicElementIdAttributes('title-1')).toEqual({ 'data-maic-element-id': 'title-1' });
    expect(INTERACTION_ELEMENT_ID_ATTRIBUTES[0]).toBe(MAIC_ELEMENT_ID_ATTRIBUTE);
    expect(INTERACTION_ELEMENT_ID_ATTRIBUTES).toContain('data-element-id');
    expect(INTERACTION_ELEMENT_ID_ATTRIBUTES).toContain('data-select-element-id');
    expect(INTERACTION_ELEMENT_ID_ATTRIBUTES).toContain('data-context-element-id');
  });
});
