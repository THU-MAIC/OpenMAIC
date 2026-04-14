import { type NextRequest } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { createAdminClient } from '@/utils/supabase/admin';
import { cookies } from 'next/headers';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('Feedback API');
const ADMIN_EMAIL = 'chalk.core@gmail.com';

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const adminClient = createAdminClient();
    const { data: { user } } = await supabase.auth.getUser();

    const body = await request.json();
    const { type, content, screenshot, url, metadata } = body;

    if (!type || !content) {
      return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'Type and content are required');
    }

    let screenshot_url = null;

    if (screenshot) {
      // Decode base64 screenshot
      const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const fileName = `${user?.id || 'anon'}_${Date.now()}.png`;

      const { error: uploadError } = await adminClient.storage
        .from('feedback-screenshots')
        .upload(fileName, buffer, {
          contentType: 'image/png',
          upsert: true,
        });

      if (uploadError) {
        log.error('Failed to upload screenshot:', uploadError);
      } else {
        const { data: { publicUrl } } = adminClient.storage
          .from('feedback-screenshots')
          .getPublicUrl(fileName);
        screenshot_url = publicUrl;
      }
    }

    const { error: insertError } = await adminClient.from('feedbacks').insert({
      user_id: user?.id || null,
      user_email: user?.email || null,
      type,
      content,
      screenshot_url,
      url: url || request.headers.get('referer'),
      metadata: metadata || {},
    });

    if (insertError) {
      log.error('Failed to insert feedback:', insertError);
      return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to save feedback');
    }

    return apiSuccess({ message: 'Feedback submitted successfully' });
  } catch (error) {
    log.error('Feedback submission error:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Internal server error');
  }
}

export async function GET(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();

    if (!user || user.email !== ADMIN_EMAIL) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 403, 'Unauthorized');
    }

    const { data, error } = await supabase
      .from('feedbacks')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      log.error('Failed to fetch feedbacks:', error);
      return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to fetch feedbacks');
    }

    return apiSuccess({ feedbacks: data });
  } catch (error) {
    log.error('Feedback fetch error:', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Internal server error');
  }
}
