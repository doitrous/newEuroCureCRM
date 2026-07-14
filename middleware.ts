import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Routes reachable without a session. Everything else in the app requires one.
 * Webhook + ingest endpoints authenticate with their own shared secrets
 * (`CRM_INGEST_API_KEY`, the Meta verify tokens) and must not be redirected to
 * a sign-in page — a 302 would silently break delivery from Meta / n8n.
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/auth",
  "/api/webhooks",
  "/api/ingest",
  "/api/crm/ingest",
  "/api/crm/mirror",
  "/api/cron",
  "/api/health",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Refreshes the Supabase auth cookies on every request and bounces anonymous
 * traffic to `/login`.
 *
 * This is a *filter*, not the authorization boundary: it only proves that some
 * valid Supabase Auth session exists. Whether that session maps to an active
 * `crm_users` profile — and what role it has — is decided server-side by
 * `requireUser()` in `lib/data/session.ts`, which every protected page calls.
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error("CRM authentication is not configured.");
    return NextResponse.json(
      { error: "Application authentication is not configured." },
      { status: 503 },
    );
  }

  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Revalidates the JWT against the Auth server and rotates the cookies. Must be
  // called before any early return, or sessions silently expire mid-use.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublic(request.nextUrl.pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Preserve where they were headed so sign-in can send them back.
    url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  /**
   * Skip Next internals and static assets. Note `/login` is *not* excluded here:
   * it still needs the cookie-refresh pass above so an expiring session is
   * renewed rather than dropped.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
