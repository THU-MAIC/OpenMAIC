import NextAuth from 'next-auth';
import { PrismaAdapter } from '@auth/prisma-adapter';
import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';
import GitHubProvider from 'next-auth/providers/github';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/auth/prisma';
import type { Role } from '@prisma/client';

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'jwt' },
  pages: {
    signIn: '/auth/signin',
    error: '/auth/signin',
  },
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = String(credentials.email).toLowerCase().trim();
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.hashedPassword || !user.isActive) return null;

        const valid = await bcrypt.compare(String(credentials.password), user.hashedPassword);
        if (!valid) return null;

        await prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        });

        return { id: user.id, email: user.email, name: user.name, role: user.role };
      },
    }),
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          }),
        ]
      : []),
    ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? [
          GitHubProvider({
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
          }),
        ]
      : []),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: Role }).role ?? 'STUDENT';
      }
      // Refresh role on every request in case admin changed it
      if (token.id) {
        try {
          const dbUser = await prisma.user.findUnique({
            where: { id: token.id as string },
            select: { role: true, isActive: true, consentGiven: true },
          });
          if (dbUser) {
            token.role = dbUser.role;
            token.isActive = dbUser.isActive;
            token.consentGiven = dbUser.consentGiven;
          }
        } catch (error) {
          // Keep the existing token payload so /api/auth/session does not fail hard.
          console.error('[auth][jwt] Failed to refresh token fields from DB:', error);
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = (token.id as string) || session.user.id;
        session.user.role = (token.role as Role) || 'STUDENT';
        session.user.isActive = (token.isActive as boolean) ?? true;
        session.user.consentGiven = (token.consentGiven as boolean) ?? false;
      }
      return session;
    },
    async signIn({ account }) {
      // OAuth users get STUDENT role by default; admin can promote them later
      if (account?.provider !== 'credentials') {
        return true;
      }
      return true;
    },
    async redirect({ url, baseUrl, token }) {
      // If a specific callbackUrl was requested (not just root), honour it.
      // Otherwise route by role: ADMIN → /admin, INSTRUCTOR → /instructor.
      const isRootOrBase =
        url === baseUrl ||
        url === `${baseUrl}/` ||
        url === '/' ||
        url === '';
      if (!isRootOrBase) {
        // Allow relative URLs and same-origin absolute URLs.
        if (url.startsWith('/')) return url;
        if (url.startsWith(baseUrl)) return url;
        return baseUrl;
      }
      // Root destination — route by role from the JWT token.
      const role = (token as { role?: string } | undefined)?.role;
      if (role === 'ADMIN') return `${baseUrl}/admin`;
      if (role === 'INSTRUCTOR') return `${baseUrl}/instructor`;
      return baseUrl;
    },
  },
  events: {
    async createUser({ user }) {
      // Assign default STUDENT role and update lastLoginAt for OAuth sign-upp
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
    },
  },
  trustHost: true,
});
