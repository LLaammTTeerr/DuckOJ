/**
 * The two mails this platform sends, in both of its languages.
 *
 * DuckOJ's own web catalogues live in `apps/web/src/i18n/` and cannot be
 * reached from here — mail is composed on the server, for a reader who is not
 * looking at the app and whose browser this process never sees. So the only
 * thing that can pick the language is `users.locale`, and the only thing that
 * can hold the words is this file.
 *
 * It stays a hand-written pair of template functions rather than a catalogue
 * with keys, deliberately: there are two messages, they are whole paragraphs
 * rather than labels, and a `t('mail.reset.body')` split across a key table
 * would make the Vietnamese and the English impossible to read side by side —
 * which, for two messages that must say the same thing, is the only review
 * that matters.
 */
import type { OutboundEmail } from './mailer.js';

export type MailLocale = 'vi' | 'en';

/**
 * Which language to write in, from whatever `users.locale` holds.
 *
 * `null` — nobody chose — is Vietnamese, exactly as D18 makes `vi` the web's
 * default: this is a Vietnamese olympiad judge, and the server has no
 * `navigator.language` to fall back to. A stored tag is matched by PREFIX
 * (`en-GB` is English), and anything else this build has no words for is
 * Vietnamese rather than a half-translated message.
 */
export function resolveMailLocale(stored: string | null): MailLocale {
  return stored !== null && stored.toLowerCase().startsWith('en') ? 'en' : 'vi';
}

export function passwordResetMail(
  locale: MailLocale,
  vars: { url: string; ttlMinutes: number },
): Omit<OutboundEmail, 'to'> {
  const minutes = String(vars.ttlMinutes);
  if (locale === 'en') {
    return {
      subject: 'Reset your DuckOJ password',
      text:
        `Someone asked to reset the password for this account.\n\n` +
        `${vars.url}\n\n` +
        `This link works once and expires in ${minutes} minutes. ` +
        `If it was not you, nothing has changed and you can ignore this message.\n`,
    };
  }
  return {
    subject: 'Đặt lại mật khẩu DuckOJ của bạn',
    text:
      `Có người vừa yêu cầu đặt lại mật khẩu cho tài khoản này.\n\n` +
      `${vars.url}\n\n` +
      `Liên kết này chỉ dùng được một lần và hết hạn sau ${minutes} phút. ` +
      `Nếu không phải bạn thì không có gì thay đổi cả, bạn có thể bỏ qua thư này.\n`,
  };
}

export function emailVerificationMail(
  locale: MailLocale,
  vars: { url: string; ttlHours: number },
): Omit<OutboundEmail, 'to'> {
  const hours = String(vars.ttlHours);
  if (locale === 'en') {
    return {
      subject: 'Confirm your DuckOJ email address',
      text:
        `Confirm this address to finish setting up your DuckOJ account.\n\n` +
        `${vars.url}\n\n` +
        `This link works once and expires in ${hours} hours.\n`,
    };
  }
  return {
    subject: 'Xác nhận địa chỉ email DuckOJ của bạn',
    text:
      `Hãy xác nhận địa chỉ này để hoàn tất việc tạo tài khoản DuckOJ của bạn.\n\n` +
      `${vars.url}\n\n` +
      `Liên kết này chỉ dùng được một lần và hết hạn sau ${hours} giờ.\n`,
  };
}
