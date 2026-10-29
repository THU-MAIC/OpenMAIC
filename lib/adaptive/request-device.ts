export interface RequestDevice {
  deviceType: 'mobile' | 'tablet' | 'desktop' | 'unknown';
  browserContext: 'wechat' | 'browser' | 'unknown';
  os: 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'unknown';
  detectionVersion: 1;
  initialMobileLayout: boolean;
}

/** Best-effort UA hints, never an authorization or actual viewport measurement. */
export function identifyRequestDevice(userAgent: string | null): RequestDevice {
  const ua = userAgent ?? '';
  const os: RequestDevice['os'] = /iPhone|iPad|iPod/i.test(ua)
    ? 'ios'
    : /Android/i.test(ua)
      ? 'android'
      : /Windows NT/i.test(ua)
        ? 'windows'
        : /Macintosh|Mac OS X/i.test(ua)
          ? 'macos'
          : /Linux/i.test(ua)
            ? 'linux'
            : 'unknown';
  const deviceType: RequestDevice['deviceType'] =
    /iPad|Tablet/i.test(ua) || (os === 'android' && !/Mobile/i.test(ua))
      ? 'tablet'
      : /iPhone|iPod|Mobile/i.test(ua)
        ? 'mobile'
        : ['windows', 'macos', 'linux'].includes(os)
          ? 'desktop'
          : 'unknown';
  return {
    deviceType,
    browserContext: /MicroMessenger/i.test(ua)
      ? 'wechat'
      : /Mozilla|Chrome|Safari|Firefox|Edg\//i.test(ua)
        ? 'browser'
        : 'unknown',
    os,
    detectionVersion: 1,
    initialMobileLayout: deviceType === 'mobile',
  };
}
