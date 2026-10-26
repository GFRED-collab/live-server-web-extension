import nodemailer from 'nodemailer';

/**
 * Outgoing email for sign-in codes. SMTP_URL is the mailbox's SMTP server, for example
 * smtps://no-reply%40kobalinesystems.com:PASSWORD@ruby.webhostingireland.ie:465
 * MAIL_FROM is the sender shown to customers.
 *
 * For local testing only (never in production), MAIL_TRANSPORT=log writes the message to the
 * server log instead of sending it.
 */
export function emailConfigured() {
  return Boolean(process.env.SMTP_URL) || testTransport();
}

function testTransport() {
  return process.env.MAIL_TRANSPORT === 'log' && process.env.NODE_ENV !== 'production';
}

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;

export async function sendSignInCode(to: string, code: string) {
  const from =
    process.env.MAIL_FROM || 'Irish Hospital Supplies Reports <no-reply@kobalinesystems.com>';
  const subject = `${code} is your Irish Hospital Supplies sign-in code`;
  const text = [
    `Your Irish Hospital Supplies sign-in code is ${code}.`,
    '',
    'It expires in 10 minutes. If you did not try to sign in, you can ignore this email;',
    'your account stays protected by your password.'
  ].join('\n');
  if (testTransport()) {
    console.log(`[mail:test] to=${to} subject="${subject}"`);
    return;
  }
  if (!process.env.SMTP_URL) throw new Error('Email sign-in codes are not set up on this server.');
  transport ??= nodemailer.createTransport(process.env.SMTP_URL);
  await transport.sendMail({ from, to, subject, text });
}
