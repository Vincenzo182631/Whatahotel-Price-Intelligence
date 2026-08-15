/**
 * Tolerant JSON parsing for the WhataHotel API.
 *
 * The API intermittently emits a trailing comma before a closing bracket:
 *
 *     "images": [
 *         { "imgFile": "…", "imgDesc": "…" },
 *     ]
 *
 * which is not valid JSON. Observed in production collection on roughly 20% of
 * `rates` calls for some hotels, always on the `images` array, and it is
 * deterministic per hotel and stay — so retrying returns the identical broken
 * body. Every rate for that hotel would be permanently uncollectable.
 *
 * The repair is deliberately the narrowest one that fixes this: remove a comma
 * that is followed only by whitespace and a closing `]` or `}`. JSON has no
 * legal position for such a comma, so removing one can never change the meaning
 * of a document that was already valid. It is attempted ONLY after a strict
 * parse has failed, so a well-formed response is never touched.
 *
 * The scan tracks string state, because `"a, ]"` is legitimate content and a
 * naive regex would corrupt it.
 */

export interface LenientParseResult<T> {
  readonly value: T;
  /** True when the strict parse failed and the repair was needed. */
  readonly repaired: boolean;
}

/** Remove commas that sit immediately before a closing bracket, outside strings. */
export function stripTrailingCommas(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ',') {
      // Look ahead past whitespace for a closing bracket.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j += 1;
      const next = text[j];
      if (next === ']' || next === '}') continue; // drop the comma
    }

    out += ch;
  }

  return out;
}

/**
 * Parse, repairing trailing commas if and only if a strict parse fails.
 *
 * Throws the ORIGINAL parse error when the repair does not help, so the
 * diagnostic points at the real defect rather than at the repaired text.
 */
export function parseLenientJson<T>(text: string): LenientParseResult<T> {
  try {
    return { value: JSON.parse(text) as T, repaired: false };
  } catch (strictError) {
    let repairedText: string;
    try {
      repairedText = stripTrailingCommas(text);
    } catch {
      throw strictError;
    }
    if (repairedText === text) throw strictError;
    try {
      return { value: JSON.parse(repairedText) as T, repaired: true };
    } catch {
      throw strictError;
    }
  }
}
