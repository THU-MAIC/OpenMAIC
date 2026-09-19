/**
 * Minimal constructor declarations for the browser Web Speech API.
 *
 * TypeScript's DOM library does not expose these vendor-dependent globals.
 * Call sites define or cast the richer instance/event shape they consume.
 */
interface BrowserSpeechRecognitionConstructor {
  new (): unknown;
}

interface Window {
  SpeechRecognition?: BrowserSpeechRecognitionConstructor;
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
}
