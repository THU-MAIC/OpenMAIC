import { createLogger } from '@/lib/logger';

const log = createLogger('waitlist-sendgrid');

const WELCOME_HTML = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; background-color: #FDFDFD;">
            <div style="text-align: center; margin-bottom: 30px;">
                <h1 style="font-size: 48px; color: #073B4C; margin: 0; font-weight: 900; letter-spacing: -2px;">SLATE</h1>
            </div>
            <div style="background: white; border: 3px solid #073B4C; border-radius: 20px; padding: 30px; box-shadow: 6px 6px 0px #073B4C;">
                <h2 style="color: #073B4C; font-size: 24px; margin-top: 0;">Welcome to the future of learning!</h2>
                <p style="color: #495057; font-size: 16px; line-height: 1.6;">
                    You're now on the SLATE UP waitlist! We're building an AI-powered interactive classroom
                    where you can learn anything with personalized courses, smart AI classmates, and engaging narration.
                </p>
                <p style="color: #495057; font-size: 16px; line-height: 1.6; font-weight: bold;">Here's what awaits you:</p>
                <ul style="color: #495057; font-size: 16px; line-height: 2;">
                    <li>Personalized course generation on any topic</li>
                    <li>AI classmates: Notes Taker, Deep Thinker, Funny Mate</li>
                    <li>Interactive slides with narration</li>
                    <li>Learn at your own pace</li>
                </ul>
                <div style="text-align: center; margin: 30px 0;">
                    <a href="https://app.slateup.ai" style="background-color: #EF476F; color: white; padding: 14px 32px; border-radius: 50px; text-decoration: none; font-weight: bold; font-size: 16px; border: 2px solid #073B4C; display: inline-block;">Enter SLATE UP</a>
                </div>
            </div>
            <p style="color: #495057; font-size: 14px; text-align: center; margin-top: 20px;">
                Stay curious,<br/><strong>The Slate Up Team</strong>
            </p>
        </div>
        `;

export async function sendWelcomeEmail(toEmail: string): Promise<boolean> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromEmail = process.env.SENDER_EMAIL;

  if (!apiKey || !fromEmail) {
    log.warn('SendGrid not configured, skipping email send');
    return false;
  }

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: toEmail }] }],
        from: { email: fromEmail },
        subject: 'Welcome to SLATE UP!',
        content: [{ type: 'text/html', value: WELCOME_HTML }],
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      log.error('SendGrid error', { status: res.status, body: text });
      return false;
    }

    log.info('Welcome email sent', { toEmail, status: res.status });
    return true;
  } catch (e) {
    log.error('Failed to send welcome email', { toEmail, error: e });
    return false;
  }
}
