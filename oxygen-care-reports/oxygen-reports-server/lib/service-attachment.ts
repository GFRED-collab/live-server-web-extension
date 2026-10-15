import { containsEmoji } from './emoji-validation';
export function decodeServiceAttachment(body: Record<string, unknown>) {
  const filename = String(body.filename || '').trim(),
    encoded = String(body.content || '');
  if (
    !filename ||
    filename.length > 180 ||
    /[\\/\x00-\x1f\x7f]/.test(filename) ||
    containsEmoji(filename)
  )
    throw Error(
      'Use a filename without emojis, slashes or control characters (up to 180 characters).'
    );
  if (
    !encoded ||
    encoded.length > 6990508 ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  )
    throw Error('Upload a valid file up to 5 MB.');
  const content = Buffer.from(encoded, 'base64');
  if (!content.length || content.length > 5 * 1024 * 1024 || content.toString('base64') !== encoded)
    throw Error('Upload a valid file up to 5 MB.');
  const extension = filename.split('.').pop()?.toLowerCase();
  let contentType = '';
  if (
    ['jpg', 'jpeg'].includes(extension || '') &&
    content[0] === 255 &&
    content[1] === 216 &&
    content[2] === 255
  )
    contentType = 'image/jpeg';
  if (
    extension === 'png' &&
    content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    contentType = 'image/png';
  if (
    extension === 'webp' &&
    content.toString('ascii', 0, 4) === 'RIFF' &&
    content.toString('ascii', 8, 12) === 'WEBP'
  )
    contentType = 'image/webp';
  if (
    extension === 'pdf' &&
    content.toString('ascii', 0, 5) === '%PDF-' &&
    content.subarray(Math.max(0, content.length - 1024)).includes(Buffer.from('%%EOF'))
  )
    contentType = 'application/pdf';
  if (!contentType)
    throw Error(
      'Only JPEG, PNG, WebP photos and PDF documents are allowed. The file contents must match its extension.'
    );
  return { filename, content, contentType };
}
