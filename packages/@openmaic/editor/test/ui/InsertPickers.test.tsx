// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundInsertPicker, LineInsertPicker } from '../../src/ui';

describe('renderer insert pickers', () => {
  it('renders line presets in editing-ui and returns the selected geometry', () => {
    const onPick = vi.fn();
    render(<LineInsertPicker labels={{ arrow: 'Arrow line' }} onPick={onPick} />);

    fireEvent.click(screen.getByRole('button', { name: 'Arrow line' }));

    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({
        style: 'solid',
        points: ['', 'arrow'],
      }),
    );
  });

  it('keeps background tabs in editing-ui and delegates image resources to the host', () => {
    const onChange = vi.fn();
    render(
      <BackgroundInsertPicker
        labels={{ solid: 'Solid', image: 'Image', color: 'Background color' }}
        onChange={onChange}
        renderImagePicker={(onPick) => (
          <button type="button" onClick={() => onPick('background.png')}>
            Choose background
          </button>
        )}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Background color hex' }), {
      target: { value: '#123456' },
    });
    fireEvent.blur(screen.getByRole('textbox', { name: 'Background color hex' }));
    expect(onChange).toHaveBeenCalledWith({ type: 'solid', color: '#123456' });

    fireEvent.click(screen.getByRole('tab', { name: 'Image' }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose background' }));
    expect(onChange).toHaveBeenCalledWith({
      type: 'image',
      image: { src: 'background.png', size: 'cover' },
    });
  });
});
