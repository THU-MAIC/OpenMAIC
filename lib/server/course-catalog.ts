import { createClient } from '@supabase/supabase-js';
import { createLogger } from '@/lib/logger';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { SceneOutline } from '@/lib/types/generation';
import type { Stage } from '@/lib/types/stage';

const log = createLogger('CourseCatalog');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

// Create a static client for background catalog operations
const supabase = createClient(supabaseUrl, supabaseKey);

export interface CourseTags {
  subject: string;
  age_range: string;
  topic: string;
  sub_topic: string;
}

/**
 * Inserts a course into the public catalog and generates AI tags in the background.
 */
export async function insertCourseAndGenerateTags(
  stage: Stage,
  outlines: SceneOutline[],
  requirement: string,
  aiCall: AICallFn,
) {
  try {
    log.info(`Inserting course into catalog: ${stage.id}`);

    // 1. Insert/Update course basic info
    const { error: courseError } = await supabase.from('courses').upsert({
      id: stage.id,
      title: stage.name,
      description: outlines[0]?.description || requirement.slice(0, 200),
      slide_count: outlines.length,
      language: stage.language || 'en-US',
      updated_at: new Date().toISOString(),
    });

    if (courseError) {
      log.error('Failed to insert course into Supabase:', courseError);
      return;
    }

    // 2. Generate AI tags
    log.info(`Generating AI tags for course: ${stage.id}`);
    const tags = await generateCourseTags(stage, outlines, requirement, aiCall);
    
    if (tags) {
      // 3. Insert tags
      const tagEntries = [
        { course_id: stage.id, tag_type: 'subject', tag_value: tags.subject },
        { course_id: stage.id, tag_type: 'age_range', tag_value: tags.age_range },
        { course_id: stage.id, tag_type: 'topic', tag_value: tags.topic },
        { course_id: stage.id, tag_type: 'sub_topic', tag_value: tags.sub_topic },
      ];

      const { error: tagError } = await supabase.from('course_tags').upsert(tagEntries, {
        onConflict: 'course_id,tag_type,tag_value'
      });

      if (tagError) {
        log.error('Failed to insert course tags:', tagError);
      } else {
        log.info(`Successfully generated and stored tags for course: ${stage.id}`);
      }
    }
  } catch (error) {
    log.error('Error in catalog background task:', error);
  }
}

async function generateCourseTags(
  stage: Stage,
  outlines: SceneOutline[],
  requirement: string,
  aiCall: AICallFn,
): Promise<CourseTags | null> {
  const language = stage.language === 'zh-CN' ? 'Chinese' : 'English';
  
  const systemPrompt = `You are an expert curriculum tagger. Your task is to analyze course content and provide metadata tags for a catalog.
Return ONLY valid JSON. No markdown fences, no explanation.

Expected JSON format:
{
  "subject": "e.g., Mathematics, Science, History, Language Arts",
  "age_range": "e.g., 5-10, 12-18, 18-99",
  "topic": "e.g., Algebra, Biology, Ancient Rome",
  "sub_topic": "e.g., Quadratic Equations, Photosynthesis, Julius Caesar"
}

Rules:
1. age_range must be in "x-y" format (e.g. 10-15). Use 0-100 for general audiences.
2. Subject should be a broad category.
3. Topic and sub-topic should be increasingly specific.
4. Output language must be ${language}.`;

  const userPrompt = `Course Title: ${stage.name}
User Requirement: ${requirement}
Scene Outlines:
${outlines.map((o, i) => `${i + 1}. ${o.title}: ${o.description}`).join('\n')}

Generate the specific tags for this course.`;

  try {
    const response = await aiCall(systemPrompt, userPrompt);
    const cleaned = response.trim().replace(/^```json\s*|\s*```$/g, '');
    const tags = JSON.parse(cleaned) as CourseTags;
    
    // Basic validation
    if (tags.subject && tags.age_range && tags.topic) {
      return tags;
    }
    return null;
  } catch (error) {
    log.error('Failed to generate course tags with AI:', error);
    return null;
  }
}
