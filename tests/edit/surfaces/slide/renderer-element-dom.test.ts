import { describe, expect, it } from 'vitest';
import {
  EDITABLE_ELEMENT_ID_PREFIX,
  editableElementDomId,
} from '@/components/edit/surfaces/slide/renderer-element-dom';

describe('renderer editor DOM contract', () => {
  it('uses the same stable id format consumed by timeline pick and teaching effects', () => {
    expect(EDITABLE_ELEMENT_ID_PREFIX).toBe('editable-element-');
    expect(editableElementDomId('title-1')).toBe('editable-element-title-1');
  });
});
