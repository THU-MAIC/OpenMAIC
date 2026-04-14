import { createClient } from '@supabase/supabase-js';
import { createLogger } from '@/lib/logger';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { SceneOutline } from '@/lib/types/generation';
import type { Stage } from '@/lib/types/stage';
import { callLLM } from '@/lib/ai/llm';
import { resolveModel } from '@/lib/server/resolve-model';

const log = createLogger('CourseCatalog');

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

// Create a static client for background catalog operations
const supabase = createClient(supabaseUrl, supabaseKey);

export interface CourseCatalogMetadata {
  /** Crisp, catalog-ready title (3–7 words) */
  catalog_title: string;
  subject: string;
  age_range: string;
  topic: string;
  sub_topic: string;
}

/** @deprecated Use CourseCatalogMetadata */
export type CourseTags = CourseCatalogMetadata;

/**
 * Inserts a course into the public catalog and generates AI metadata
 * (title + tags) in the background.
 */
export async function insertCourseAndGenerateTags(
  stage: Stage,
  outlines: SceneOutline[],
  requirement: string,
  aiCall: AICallFn,
) {
  try {
    log.info(`Inserting course into catalog: ${stage.id}`);

    // 1. Insert/Update course with the raw name first so it appears immediately
    const { error: courseError } = await supabase.from('courses').upsert({
      id: stage.id,
      stage_id: stage.id,
      name: stage.name,
      title: stage.name,
      description: outlines[0]?.description || requirement.slice(0, 200),
      slide_count: outlines.length,
      language: stage.language || 'en-US',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

    if (courseError) {
      log.error('Failed to insert course into Supabase:', courseError);
      return;
    }

    // 2. Generate AI metadata (crisp title + classification tags)
    log.info(`Generating AI catalog metadata for course: ${stage.id}`);
    const metadata = await generateCourseMetadata({
      name: stage.name,
      language: stage.language || 'en-US',
      requirement,
      outlineContext: outlines.map((o, i) => `${i + 1}. ${o.title}: ${o.description}`).join('\n'),
      aiCall,
    });

    if (metadata) {
      // 3. Update the course title with the AI-generated catalog title
      const { error: titleError } = await supabase
        .from('courses')
        .update({ name: metadata.catalog_title, title: metadata.catalog_title })
        .eq('id', stage.id);

      if (titleError) {
        log.error('Failed to update catalog title:', titleError);
      } else {
        log.info(`Catalog title updated for ${stage.id}: "${metadata.catalog_title}"`);
      }

      // 4. Insert classification tags
      const tagEntries = [
        { course_id: stage.id, tag_type: 'subject', tag_value: metadata.subject },
        { course_id: stage.id, tag_type: 'age_range', tag_value: metadata.age_range },
        { course_id: stage.id, tag_type: 'topic', tag_value: metadata.topic },
        { course_id: stage.id, tag_type: 'sub_topic', tag_value: metadata.sub_topic },
      ];

      const { error: tagError } = await supabase.from('course_tags').upsert(tagEntries, {
        onConflict: 'course_id,tag_type,tag_value',
      });

      if (tagError) {
        log.error('Failed to insert course tags:', tagError);
      } else {
        log.info(`Catalog metadata stored for course: ${stage.id}`);
      }
    }
  } catch (error) {
    log.error('Error in catalog background task:', error);
  }
}

/**
 * Generate catalog metadata for a course that was uploaded from the client
 * (generation-preview flow). Uses the default server model via callLLM.
 *
 * Fired as a background task from POST /api/courses.
 */
export async function generateCatalogMetadataForCourse(params: {
  courseId: string;
  courseName: string;
  language: string;
  /** Scene titles from the generated course */
  sceneTitles: string[];
}): Promise<void> {
  const { courseId, courseName, language, sceneTitles } = params;

  try {
    log.info(`Generating catalog metadata for client course: ${courseId}`);

    const { model } = resolveModel({});

    const aiCall: AICallFn = async (systemPrompt, userPrompt) => {
      const result = await callLLM(
        {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          maxOutputTokens: 512,
        },
        'course-catalog-metadata',
      );
      return result.text;
    };

    const outlineContext = sceneTitles
      .map((title, i) => `${i + 1}. ${title}`)
      .join('\n');

    const metadata = await generateCourseMetadata({
      name: courseName,
      language,
      requirement: courseName,
      outlineContext,
      aiCall,
    });

    if (!metadata) return;

    const { error: titleError } = await supabase
      .from('courses')
      .update({ name: metadata.catalog_title, title: metadata.catalog_title })
      .eq('id', courseId);

    if (titleError) {
      log.error('Failed to update catalog title for client course:', titleError);
    } else {
      log.info(`Catalog title updated for client course ${courseId}: "${metadata.catalog_title}"`);
    }

    const tagEntries = [
      { course_id: courseId, tag_type: 'subject', tag_value: metadata.subject },
      { course_id: courseId, tag_type: 'age_range', tag_value: metadata.age_range },
      { course_id: courseId, tag_type: 'topic', tag_value: metadata.topic },
      { course_id: courseId, tag_type: 'sub_topic', tag_value: metadata.sub_topic },
    ];

    const { error: tagError } = await supabase.from('course_tags').upsert(tagEntries, {
      onConflict: 'course_id,tag_type,tag_value',
    });

    if (tagError) {
      log.error('Failed to insert tags for client course:', tagError);
    } else {
      log.info(`Catalog metadata stored for client course: ${courseId}`);
    }
  } catch (error) {
    log.error('Error generating catalog metadata for client course:', error);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface GenerateMetadataParams {
  name: string;
  language: string;
  requirement: string;
  outlineContext: string;
  aiCall: AICallFn;
}

async function generateCourseMetadata(
  params: GenerateMetadataParams,
): Promise<CourseCatalogMetadata | null> {
  const { name, language, requirement, outlineContext, aiCall } = params;
  const lang = language === 'zh-CN' ? 'Chinese' : 'English';

  const systemPrompt = `You are an expert curriculum cataloger. Analyze course content and return catalog metadata.
Return ONLY valid JSON. No markdown fences, no explanation.

Expected JSON format:
{
  "catalog_title": "Crisp 3-7 word title for a course catalog listing",
  "subject": "Broad subject area, e.g. Mathematics, Science, History, Language Arts",
  "age_range": "Target age range in x-y format, e.g. 10-15. Use 0-100 for all ages.",
  "topic": "Specific topic, e.g. Algebra, Biology, Ancient Rome",
  "sub_topic": "Narrow sub-topic, e.g. Quadratic Equations, Photosynthesis, Julius Caesar"
}

Rules:
1. catalog_title must be concise (3-7 words), engaging, and clearly convey the course subject.
   It should be suitable as a card title in a public course catalog — not a raw prompt.
2. age_range must use "x-y" format. Use 0-100 for general audiences.
3. Subject should be a broad category.
4. Topic and sub_topic should be increasingly specific.
5. All output fields must be in ${lang}.`;

  const userPrompt = `Course Name (raw): ${name}
User Requirement: ${requirement}
Scene Outlines:
${outlineContext}

Generate catalog metadata for this course.`;

  try {
    const response = await aiCall(systemPrompt, userPrompt);
    const cleaned = response.trim().replace(/^```json\s*|\s*```$/g, '');
    const metadata = JSON.parse(cleaned) as CourseCatalogMetadata;

    if (metadata.catalog_title && metadata.subject && metadata.age_range && metadata.topic) {
      return metadata;
    }
    log.warn('AI returned incomplete catalog metadata:', metadata);
    return null;
  } catch (error) {
    log.error('Failed to generate course catalog metadata:', error);
    return null;
  }
}
