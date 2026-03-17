import { apiSuccess } from '@/lib/server/api-response';

const version = process.env.npm_package_version || '0.1.0';

export async function GET() {
  return apiSuccess({ status: 'ok', version });
}
