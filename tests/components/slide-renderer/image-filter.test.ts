import { describe, expect, it } from 'vitest';
import { imageFiltersToCss } from '@/components/slide-renderer/components/element/ImageElement/useFilter';

describe('imageFiltersToCss', () => {
  it('renders the current DSL filter map used by edit_elements', () => {
    expect(
      imageFiltersToCss({
        blur: '2',
        brightness: '120',
        'hue-rotate': '15',
      }),
    ).toBe('blur(2px) brightness(120%) hue-rotate(15deg)');
  });
});
