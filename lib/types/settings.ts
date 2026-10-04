/**
 * Sections of the settings dialog. Token Plan, Model Services and Course
 * Model show the workspace's model configuration, which lives on the server;
 * Skills and General are the user's own. The Model Services tabs keep their
 * own values (`providers`, `image`, ...) so an opener can go straight to one.
 */
export type SettingsSection =
  | 'general'
  | 'token-plan'
  | 'providers'
  | 'tts'
  | 'asr'
  | 'pdf'
  | 'image'
  | 'video'
  | 'web-search'
  | 'skills'
  | 'course-models'
  | 'model-services';
