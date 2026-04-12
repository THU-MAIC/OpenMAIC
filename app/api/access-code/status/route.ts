import { cookies } from 'next/headers';
import { apiSuccess } from '@/lib/server/api-response';
import { verifyAccessToken } from '@/app/api/access-code/verify/route';

export async function GET() {
  const accessCode = process.env.ACCESS_CODE;
  const enabled = !!accessCode;

  let authenticated = false;
  if (enabled) {
    const cookieStore = await cookies();
    const token = cookieStore.get('openmaic_access')?.value;
    authenticated = !!token && verifyAccessToken(token, accessCode);
  }

  return apiSuccess({ enabled, authenticated });
}
