import { containsEmoji } from './emoji-validation';

/** Preserve international names and punctuation while rejecting emoji sequences. */
export function validateClientName(value: unknown): string {
  const name = String(value ?? '').trim();
  if (!name) throw new Error('Client name is required.');
  if (containsEmoji(name)) {
    throw new Error('Emojis are not allowed in client names. Please use text instead.');
  }
  return name;
}
