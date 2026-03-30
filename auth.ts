import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';
import { prisma } from '@/lib/server/db';
import { headers } from 'next/headers';

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const headerList = await headers();
        console.log('[Auth] Diagnosing Host:', {
          host: headerList.get('host'),
          forwardedHost: headerList.get('x-forwarded-host'),
          forwardedProto: headerList.get('x-forwarded-proto'),
        });
        console.log('[Auth] Authorizing User:', credentials?.email);
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return null;

        const valid = await compare(password, user.password);
        if (!valid) return null;

        return { id: user.id, email: user.email, name: user.name, role: user.role };
      },
    }),
  ],
  session: { strategy: 'jwt' },
  pages: { signIn: '/login' },
  callbacks: {
    async redirect({ url, baseUrl }) {
      // Get the current domain from headers (works for both local and tunnel)
      const headerList = await headers();
      const host = headerList.get('x-forwarded-host') || headerList.get('host');
      const proto = headerList.get('x-forwarded-proto') || 'http';

      if (host) {
        const dynamicBaseUrl = `${proto}://${host}`;
        // If the redirect URL is relative, prefix it with our dynamic base
        if (url.startsWith('/')) {
          return `${dynamicBaseUrl}${url}`;
        }
        // If it's already an absolute URL, check if it's pointing to localhost
        // and rewrite it to the dynamic public domain users are actually using.
        try {
          const urlObj = new URL(url);
          if (
            urlObj.hostname === 'localhost' ||
            urlObj.hostname === '127.0.0.1' ||
            urlObj.origin === baseUrl
          ) {
            return `${dynamicBaseUrl}${urlObj.pathname}${urlObj.search}`;
          }
        } catch (e) {
          // Ignore invalid URLs
        }
      }

      // Default Auth.js behavior for other cases
      return url.startsWith(baseUrl) ? url : baseUrl + url;
    },
    jwt({ token, user }) {
      if (user) {
        token.id = user.id!;
        token.role = (user as { role?: string }).role ?? 'teacher';
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        (session.user as { role?: string }).role = token.role as string;
      }
      return session;
    },
  },
});
