/**
 * Detects Personally Identifiable Information (PII) in a given text.
 * @param {string} text - The input string to analyze.
 * @returns {Array<{type: string, match: string, startIndex: number, endIndex: number}>}
 */
export function detectPII(text) {
  if (typeof text !== 'string' || !text) {
    return [];
  }

  const results = [];

  const patterns = [
    { type: 'EMAIL', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
    { type: 'PHONE', regex: /(?<!\d)[6-9]\d{9}(?!\d)/g },
    { type: 'CARD_NUMBER', regex: /(?<!\d[ -]?)(?:\d[ -]?){15}\d(?![ -]?\d)/g },
    { type: 'AADHAAR', regex: /(?<!\d[ -]?)(?:\d[ -]?){11}\d(?![ -]?\d)/g },
    { type: 'IFSC', regex: /\b[A-Za-z]{4}0[A-Za-z0-9]{6}\b/g }
  ];

  for (const { type, regex } of patterns) {
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(text)) !== null) {
      results.push({
        type,
        match: match[0],
        startIndex: match.index,
        endIndex: match.index + match[0].length
      });
    }
  }

  const otpRegex = /(?<!\d[ -]?)\d{4,6}(?![ -]?\d)/g;
  const otpContextRegex = /\b(otp|code|verification)\b/i;
  let match;

  while ((match = otpRegex.exec(text)) !== null) {
    const startIndex = match.index;
    const endIndex = startIndex + match[0].length;

    const contextStart = Math.max(0, startIndex - 30);
    const contextEnd = Math.min(text.length, endIndex + 30);
    const context = text.substring(contextStart, contextEnd);

    if (otpContextRegex.test(context)) {
      results.push({
        type: 'OTP',
        match: match[0],
        startIndex,
        endIndex
      });
    }
  }

  return results;
}
