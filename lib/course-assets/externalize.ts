import { uploadCourseDataUri } from './client';

type RecordLike = Record<string, unknown>;

export interface ExternalizedCourseAssets {
  stage: RecordLike;
  scenes: RecordLike[];
  converted: { images: number; audio: number };
}

const isDataUri = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('data:');

/** Deep-copy and replace all cloud-persisted inline assets with HTTPS URLs. */
export async function externalizeCourseAssets(
  courseId: string,
  stageInput: RecordLike,
  scenesInput: RecordLike[],
): Promise<ExternalizedCourseAssets> {
  const stage = structuredClone(stageInput);
  const scenes = structuredClone(scenesInput);
  let images = 0;
  let audio = 0;

  const data = stage.data as RecordLike | undefined;
  const imageMapping = data?.imageMapping as Record<string, unknown> | undefined;
  if (imageMapping) {
    for (const [key, value] of Object.entries(imageMapping)) {
      if (!isDataUri(value)) continue;
      imageMapping[key] = await uploadCourseDataUri(courseId, 'images', value);
      images++;
    }
  }

  for (const scene of scenes) {
    if (isDataUri(scene.narrationAudioUrl)) {
      scene.narrationAudioUrl = await uploadCourseDataUri(courseId, 'audio', scene.narrationAudioUrl);
      audio++;
    }
    const actions = Array.isArray(scene.actions) ? scene.actions as RecordLike[] : [];
    for (const action of actions) {
      if (!isDataUri(action.audioUrl)) continue;
      action.audioUrl = await uploadCourseDataUri(courseId, 'audio', action.audioUrl);
      audio++;
    }
  }
  return { stage, scenes, converted: { images, audio } };
}
