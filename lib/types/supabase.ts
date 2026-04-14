import type { SceneType, SceneContent } from './stage';
import type { Action } from './action';
import type { Slide } from './slides';

export interface SupabasePrompt {
  id: string;
  user_id: string;
  course_id?: string;
  requirement: string;
  language: string;
  pdf_file_name?: string;
  web_search?: boolean;
  aspect_ratio?: string;
  user_nickname?: string;
  user_bio?: string;
  created_at: string;
}

export interface SupabaseCourse {
  id: string;
  user_id: string;
  creation_prompt_id?: string;
  stage_id: string;
  name: string;
  description?: string;
  thumbnail?: string;
  slide_count: number;
  language?: string;
  style?: string;
  created_at: string;
  updated_at: string;
}

export interface SupabaseScene {
  id: string;
  course_id: string;
  scene_id: string;
  type: SceneType;
  title: string;
  order: number;
  content: SceneContent;
  actions?: Action[];
  whiteboards?: Slide[];
  created_at: string;
  updated_at: string;
}

/** Lightweight metadata for the "Recent" list */
export interface CourseListItem {
  id: string;
  stage_id: string;
  name: string;
  thumbnail?: string;
  slide_count: number;
  created_at: string;
  updated_at: string;
  is_cloud: boolean;
}
