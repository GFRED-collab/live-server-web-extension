import strictAssert from 'node:assert/strict';

// Source-text checks should survive code formatting. Both the text and the
// pattern are compared with whitespace removed, quotes unified, and the CSS
// final semicolon and HTML void-tag slash dropped, so the checks still pin the
// same code without depending on line breaks or spacing.
const normalizeText = text =>
  String(text).replace(/\s+/g, '').replace(/"/g, "'").replace(/;}/g, '}').replace(/\/>/g, '>');

function normalizePattern(pattern) {
  const source = pattern.source
    .replace(/\\s[+*]?\??/g, '')
    .replace(/\\n|\\t| /g, '')
    .replace(/\\"|"/g, "'")
    .replace(/;\\}/g, '\\}')
    .replace(/\\\/>/g, '>');
  return new RegExp(source, pattern.flags);
}

const assert = Object.assign((...args) => strictAssert(...args), strictAssert, {
  match: (text, pattern, message) =>
    strictAssert.match(normalizeText(text), normalizePattern(pattern), message),
  doesNotMatch: (text, pattern, message) =>
    strictAssert.doesNotMatch(normalizeText(text), normalizePattern(pattern), message)
});

export default assert;
