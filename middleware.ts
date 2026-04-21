import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/utils/supabase/middleware";

function getAllowedOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS;
  const defaults = [
    "http://localhost:3001",
    "https://slateup.ai",
    "https://www.slateup.ai",
  ];
  if (!raw) return defaults;
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length ? parsed : defaults;
}

function withCors(req: NextRequest, res: NextResponse): NextResponse {
  const origin = req.headers.get("origin");
  if (!origin) return res;

  const allowed = getAllowedOrigins();
  if (!allowed.includes(origin) && !allowed.includes("*")) return res;

  res.headers.set("Access-Control-Allow-Origin", allowed.includes("*") ? "*" : origin);
  res.headers.set("Vary", "Origin");
  res.headers.set("Access-Control-Allow-Credentials", "true");
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.headers.set(
    "Access-Control-Allow-Headers",
    req.headers.get("access-control-request-headers") ?? "Content-Type, Authorization",
  );
  res.headers.set("Access-Control-Max-Age", "86400");
  return res;
}

export async function middleware(request: NextRequest) {
  // CORS for API routes (e.g. local frontend on :3001 calling Next on :3000)
  if (request.nextUrl.pathname.startsWith("/api/")) {
    if (request.method === "OPTIONS") {
      return withCors(request, new NextResponse(null, { status: 204 }));
    }

    const res = NextResponse.next();
    return withCors(request, res);
  }

  return await updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * Feel free to modify this pattern to include more paths.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
