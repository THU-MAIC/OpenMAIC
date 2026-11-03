import { describe, expect, it } from 'vitest';
import { identifyRequestDevice } from '@/lib/adaptive/request-device';
import { MOBILE_LAYOUT_QUERY, WORKSPACE_NARROW_QUERY } from '@/lib/adaptive/media-queries';

describe('request device hints', () => {
  it('keeps unknown requests explicit', () => {
    expect(identifyRequestDevice(null)).toMatchObject({
      deviceType: 'unknown',
      initialMobileLayout: false,
    });
  });
  it('recognizes phones and WeChat independently', () => {
    expect(
      identifyRequestDevice(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile MicroMessenger/8',
      ),
    ).toMatchObject({
      deviceType: 'mobile',
      browserContext: 'wechat',
      os: 'ios',
      initialMobileLayout: true,
    });
  });
  it('does not classify Android tablets as phones', () => {
    expect(
      identifyRequestDevice('Mozilla/5.0 (Linux; Android 14; Tablet) Chrome/130 Safari/537.36'),
    ).toMatchObject({ deviceType: 'tablet', initialMobileLayout: false });
  });
  it('recognizes desktop and iPad', () => {
    expect(
      identifyRequestDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130'),
    ).toMatchObject({ deviceType: 'desktop', os: 'windows' });
    expect(identifyRequestDevice('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toMatchObject({
      deviceType: 'tablet',
      os: 'ios',
    });
  });
  it('keeps layout and workspace thresholds distinct', () => {
    expect(MOBILE_LAYOUT_QUERY).toBe(
      '(max-width: 767px), (max-height: 500px) and (pointer: coarse)',
    );
    expect(WORKSPACE_NARROW_QUERY).toBe('(max-width: 1023px)');
  });
});
