export const useCanvasStore = { getState: () => ({ pauseVideo() {}, setWhiteboardOpen() {} }) };
export const useSettingsStore = { getState: () => ({ ttsMuted: false, ttsVolume: 1 }) };
export const ttsSelection = () => undefined;
export const resolveAudioBlob = async (id: string) =>
  id ? (await fetch('http://localhost/narration.wav')).blob() : null;
