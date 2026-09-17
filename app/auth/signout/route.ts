import { NextRequest, NextResponse } from 'next/server';
import { supabaseServerClient } from '@/lib/supabase-server';

export async function POST(request: NextRequest) {
  const supabase = await supabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 });
}
