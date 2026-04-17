import { auth, signOut } from '@/lib/auth/auth';
import { prisma } from '@/lib/auth/prisma';
import { writeAuditLog } from '@/lib/auth/helpers';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * DELETE /api/user/delete-account
 * PDPA: Right to erasure — anonymize account while preserving essential academic records
 * (grades, transcripts, enrollment history)
 */
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const userId = session.user.id;

  // Log before archiving
  await writeAuditLog({
    actorId: userId,
    action: 'user.account_deletion',
    resource: 'User',
    resourceId: userId,
    req,
  });

  // Archive account: anonymize personal data while keeping academic records intact
  // Essential academic records (grades, transcripts, enrollment) are not deleted
  const timestamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  await prisma.user.update({
    where: { id: userId },
    data: {
      // Anonymize personal identifiers
      email: `deleted_user_${userId.slice(0, 8)}_${timestamp}@archived.local`,
      name: null,
      studentId: null,
      image: null,
      bio: null,
      hashedPassword: null, // User cannot log back in

      // Mark account as inactive
      isActive: false,

      // Clear sessions to force logout
      sessions: { deleteMany: {} },
      accounts: { deleteMany: {} },

      // Preserve classroom access for record-keeping
      // Note: Grades, transcripts, and enrolled courses remain linked via userId
    },
  });

  // Sign out the now-archived user
  await signOut({ redirect: false });

  return NextResponse.json({ success: true });
}
