import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/admin';

export async function POST(req: NextRequest) {
  try {
    const supabase = createAdminClient();
    const body = await req.json();
    
    const { 
      requirement, 
      language, 
      pdf_file_name, 
      web_search, 
      aspect_ratio, 
      user_nickname, 
      user_bio,
      user_id 
    } = body;

    if (!user_id || !requirement) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('prompts')
      .insert({
        user_id,
        requirement,
        language,
        pdf_file_name,
        web_search,
        aspect_ratio,
        user_nickname,
        user_bio
      })
      .select()
      .single();

    if (error) {
      console.error('Error saving prompt:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, prompt: data });
  } catch (err) {
    console.error('Unexpected error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
