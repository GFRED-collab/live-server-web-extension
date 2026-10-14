// Do not use Unicode's Emoji property here: it also matches ordinary digits.
export function containsEmoji(value: string): boolean {
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u20E3\uFE0F\u{E0020}-\u{E007F}]/u.test(value);
}

/** Validate every value and field name, including nested imported report/stock rows. */
export function rejectEmojiText(body: Record<string, unknown>, allowPassword = false): void {
  const pending: unknown[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (containsEmoji(key)) throw new Error('Emojis are not allowed in field names. Please use text instead.');
    // Only a genuine top-level credential field may contain emoji. A report
    // column named "password" must not bypass business-text validation.
    if (allowPassword && key === 'password' && typeof value === 'string') continue;
    pending.push(value);
  }
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (containsEmoji(value)) throw new Error('Emojis are not allowed in text fields. Remove them before saving.');
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (containsEmoji(key)) throw new Error('Emojis are not allowed in field names. Please use text instead.');
        pending.push(item);
      }
    }
  }
}
