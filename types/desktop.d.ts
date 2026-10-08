interface OpenMAICDesktopBridge {
  isDesktop: boolean;
  platform: string;
  version: string;
  openExternal: (url: string) => Promise<boolean>;
}

interface Window {
  openmaicDesktop?: OpenMAICDesktopBridge;
}
