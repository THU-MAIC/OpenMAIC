import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { getTemporalClient, TASK_QUEUE } from '@/temporal/client';

/**
 * GET /api/courses?userId=xxx
 * List metadata for all courses of a user.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('userId');
  const stageId = searchParams.get('stageId');

  if (!userId && !stageId) {
    return NextResponse.json({ error: 'User ID or Stage ID is required' }, { status: 400 });
  }

  try {
    const supabase = createAdminClient();
    let query = supabase.from('courses').select('id, stage_id, name, thumbnail, slide_count, created_at, updated_at');
    
    if (userId) {
      query = query.eq('user_id', userId).order('updated_at', { ascending: false });
    } else if (stageId) {
      // Query by both id and stage_id column so the lookup works regardless of whether
      // the stage_id column migration has been applied (courses.id = stage_id in our schema).
      query = query.or(`id.eq.${stageId},stage_id.eq.${stageId}`);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Error fetching courses:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, courses: data });
  } catch (err) {
    console.error('Unexpected error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/**
 * POST /api/courses
 * Atomic creation of course metadata and its scenes.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createAdminClient();
    const body = await req.json();
    
    const { 
      user_id,
      creation_prompt_id,
      stage_id,
      name,
      description,
      thumbnail,
      slide_count,
      language,
      style,
      scenes,
      stage: fullStage,         // full Stage object for complete storage serialisation
      credits_pre_consumed,     // true when generation-preview already consumed the credit
    } = body;

    if (!user_id || !stage_id || !name) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // 0. Check whether this is a brand-new course (not a re-sync of an existing one).
    //    If it is new, check & consume a course-generation credit.
    const { data: existingCourse } = await supabase
      .from('courses')
      .select('id')
      .eq('id', stage_id)
      .maybeSingle();

    if (!existingCourse) {
      if (credits_pre_consumed) {
        // Credit was already consumed at generation start — skip the RPC check
        // to avoid double-counting. The generation-preview page called
        // POST /api/user/credits/check before starting the generation.
      } else {
        // Fallback: consume credit here (e.g. direct API calls bypassing the UI)
        const { data: creditResult, error: creditError } = await supabase.rpc(
          'increment_course_credit',
          { p_user_id: user_id },
        );

        if (creditError) {
          console.error('Credit check RPC error:', creditError);
          // Non-fatal if RPC unavailable (e.g. migration not yet applied)
        } else if (creditResult && creditResult.allowed === false) {
          const reason = creditResult.reason as string;
          return NextResponse.json(
            {
              error:
                reason === 'free_limit_reached'
                  ? 'You have used all your free course credits. Upgrade to Plus for 30 courses/month.'
                  : 'You have reached your monthly course limit. Wait for your cycle to reset or upgrade.',
              reason,
              upgrade_url: '/pricing',
            },
            { status: 402 },
          );
        }
      }
    }

    // 1. Create Course Metadata (upsert so re-syncs and catalog pre-inserts don't conflict)
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .upsert({
        id: stage_id,
        user_id,
        creation_prompt_id,
        stage_id,
        name,
        // Backward-compat: old schema has `title TEXT NOT NULL` before the fix migration drops it
        title: name,
        description,
        thumbnail,
        slide_count,
        language,
        style,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' })
      .select()
      .single();

    if (courseError) {
      console.error('Error creating course:', courseError);
      return NextResponse.json({ error: courseError.message }, { status: 500 });
    }

    // 2. Insert Scenes in bulk if provided (delete existing first for idempotent re-syncs)
    if (scenes && scenes.length > 0) {
      await supabase.from('scenes').delete().eq('course_id', course.id);

      const formattedScenes = scenes.map((s: any) => ({
        course_id: course.id,
        scene_id: s.id,
        type: s.type,
        title: s.title,
        order: s.order,
        content: s.content,
        actions: s.actions,
        whiteboards: s.whiteboards
      }));

      const { error: scenesError } = await supabase
        .from('scenes')
        .insert(formattedScenes);

      if (scenesError) {
        console.error('Error creating scenes:', scenesError);
        return NextResponse.json({ 
          error: 'Course created but scenes failed', 
          details: scenesError.message,
          courseId: course.id 
        }, { status: 500 });
      }
    }

    // 3. Upload full course content JSON to Storage for fast client-side retrieval.
    //    Path: courses/{stage_id}/content.json  (public bucket, no auth needed to read)
    //    Use the full Stage object when provided so agentIds / whiteboard / generatedAgentConfigs
    //    are preserved and can be restored when the classroom is reopened on another device.
    const stageForStorage = fullStage ?? {
      id: stage_id,
      name,
      description,
      language,
      style,
      createdAt: new Date(course.created_at).getTime(),
      updatedAt: new Date(course.updated_at).getTime(),
    };

    const storageContent = JSON.stringify({
      stage: stageForStorage,
      scenes: scenes || [],
    });

    const { error: storageError } = await supabase.storage
      .from('courses')
      .upload(`${stage_id}/content.json`, storageContent, {
        contentType: 'application/json',
        upsert: true,
      });

    if (storageError) {
      // Non-fatal: the DB row is the authoritative source; storage is an optimistic cache
      console.error('Storage upload failed (non-fatal):', storageError.message);
    }

    // 4. Update the original prompt to link back to this course
    if (creation_prompt_id) {
      await supabase
        .from('prompts')
        .update({ course_id: course.id })
        .eq('id', creation_prompt_id);
    }

    // 5. Background: generate AI catalog title + tags via Temporal workflow
    const sceneTitles = (scenes ?? []).map((s: any) => s.title).filter(Boolean);
    if (name && sceneTitles.length > 0) {
      try {
        const temporalClient = await getTemporalClient();
        // Pass workflow type as a string to avoid name mangling during Next.js production builds.
        await temporalClient.workflow.start('generateCatalogMetadataWorkflow', {
          taskQueue: TASK_QUEUE,
          workflowId: `catalog-${course.id}`,
          args: [{ courseId: course.id, courseName: name, language: language || 'en-US', sceneTitles }],
        });
      } catch (temporalErr) {
        // Non-fatal: catalog metadata generation is best-effort
        console.error('Failed to start catalog metadata workflow (non-fatal):', temporalErr);
      }
    }

    return NextResponse.json({ success: true, course });
  } catch (err) {
    console.error('Unexpected error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
