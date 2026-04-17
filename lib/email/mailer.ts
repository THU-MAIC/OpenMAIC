import nodemailer from 'nodemailer';

function isSmtpConfigured() {
  return !!process.env.SMTP_HOST;
}

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth:
      process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });
}

/**
 * Send a welcome email to a newly created student with their temporary credentials.
 * No-ops if SMTP_HOST is not configured.
 */
export async function sendStudentWelcomeEmail(params: {
  to: string;
  name: string;
  temporaryPassword: string;
  classroomId?: string;
}): Promise<void> {
  if (!isSmtpConfigured()) return;

  const { to, name, temporaryPassword } = params;
  const appName = process.env.NEXT_PUBLIC_APP_NAME ?? 'MU-OpenMAIC';
  const signInUrl = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
  const from = process.env.SMTP_FROM ?? `"${appName}" <no-reply@openmaic.local>`;

  const transporter = createTransporter();

  await transporter.sendMail({
    from,
    to,
    subject: `Welcome to ${appName} — Your account credentials`,
    text: [
      `Hi ${name},`,
      '',
      `An account has been created for you on ${appName}.`,
      '',
      `Sign-in URL: ${signInUrl}`,
      `Email: ${to}`,
      `Temporary password: ${temporaryPassword}`,
      '',
      'Please sign in and change your password as soon as possible.',
      '',
      `— The ${appName} Team`,
    ].join('\n'),
    html: `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#111;">
  <h2 style="margin-bottom:8px;">Welcome to ${appName}</h2>
  <p>Hi <strong>${name}</strong>,</p>
  <p>An account has been created for you. Use the credentials below to sign in.</p>
  <table style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;width:100%;margin:16px 0;background:#f9fafb;">
    <tr><td style="color:#6b7280;padding:4px 0;width:120px;">Sign-in URL</td><td><a href="${signInUrl}" style="color:#7c3aed;">${signInUrl}</a></td></tr>
    <tr><td style="color:#6b7280;padding:4px 0;">Email</td><td>${to}</td></tr>
    <tr><td style="color:#6b7280;padding:4px 0;">Temporary password</td><td style="font-family:monospace;font-size:15px;font-weight:600;">${temporaryPassword}</td></tr>
  </table>
  <p style="color:#6b7280;font-size:13px;">Please sign in and change your password as soon as possible.</p>
  <p style="color:#6b7280;font-size:13px;margin-top:32px;">— The ${appName} Team</p>
</body>
</html>`,
  });
}

/**
 * Send a classroom invitation email to an existing student account.
 * No-ops if SMTP_HOST is not configured.
 */
export async function sendClassroomInvitationEmail(params: {
  to: string;
  name: string;
  classroomId: string;
}): Promise<void> {
  if (!isSmtpConfigured()) return;

  const { to, name, classroomId } = params;
  const appName = process.env.NEXT_PUBLIC_APP_NAME ?? 'MU-OpenMAIC';
  const signInUrl = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
  const from = process.env.SMTP_FROM ?? `"${appName}" <no-reply@openmaic.local>`;

  const transporter = createTransporter();

  await transporter.sendMail({
    from,
    to,
    subject: `You have been invited to a classroom on ${appName}`,
    text: [
      `Hi ${name},`,
      '',
      `You have been invited to access classroom ${classroomId} on ${appName}.`,
      '',
      `Sign-in URL: ${signInUrl}`,
      `Email: ${to}`,
      '',
      'Sign in with your existing account to open the classroom.',
      '',
      `— The ${appName} Team`,
    ].join('\n'),
    html: `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#111;">
  <h2 style="margin-bottom:8px;">Classroom Invitation</h2>
  <p>Hi <strong>${name}</strong>,</p>
  <p>You have been invited to access classroom <strong>${classroomId}</strong> on ${appName}.</p>
  <table style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;width:100%;margin:16px 0;background:#f9fafb;">
    <tr><td style="color:#6b7280;padding:4px 0;width:120px;">Sign-in URL</td><td><a href="${signInUrl}" style="color:#7c3aed;">${signInUrl}</a></td></tr>
    <tr><td style="color:#6b7280;padding:4px 0;">Email</td><td>${to}</td></tr>
    <tr><td style="color:#6b7280;padding:4px 0;">Classroom</td><td>${classroomId}</td></tr>
  </table>
  <p style="color:#6b7280;font-size:13px;">Sign in with your existing account to open the classroom.</p>
  <p style="color:#6b7280;font-size:13px;margin-top:32px;">— The ${appName} Team</p>
</body>
</html>`,
  });
}
