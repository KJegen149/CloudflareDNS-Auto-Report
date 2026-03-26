/**
 * Email sender for Workers runtime.
 *
 * Uses the Resend HTTP API (https://resend.com) because Workers cannot open
 * raw TCP/SMTP connections. Resend's free tier (3,000 emails/month, 100/day)
 * is sufficient for typical DNS report schedules.
 *
 * To swap providers, replace sendViaResend with a function that calls your
 * preferred transactional email API (SendGrid, Mailgun, Postmark, etc.).
 */

const RESEND_API = 'https://api.resend.com/emails';

/**
 * Send a DNS report email.
 *
 * @param {object} env     - Worker env bindings (holds secrets).
 * @param {string[]} to    - Recipient email addresses.
 * @param {string} subject - Email subject.
 * @param {string} html    - Full HTML email body.
 */
export async function sendReportEmail(env, to, subject, html) {
  const apiKey   = env.RESEND_API_KEY;
  const fromAddr = env.EMAIL_FROM_ADDRESS ?? 'reports@example.com';
  const fromName = env.EMAIL_FROM_NAME    ?? 'Cloudflare DNS Reports';

  if (!apiKey) throw new Error('RESEND_API_KEY secret is not set.');

  const payload = {
    from:    `${fromName} <${fromAddr}>`,
    to:      Array.isArray(to) ? to : [to],
    subject,
    html,
  };

  const resp = await fetch(RESEND_API, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Resend API error ${resp.status}: ${body}`);
  }

  return resp.json();
}
