// Trigger matching for monitored messages. Deliberately simple for the test layer: case-insensitive substring match.
export function normalizeText(value) {
  return String(value ?? '')
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseKeywords(raw) {
  const seen = new Set();
  const list = [];
  for (const part of String(raw ?? '').split(/[\n,;]+/)) {
    const shown = part.trim();
    const norm = normalizeText(shown);
    if (!norm || norm.length > 100 || seen.has(norm)) continue;
    seen.add(norm);
    list.push({ shown, norm });
    if (list.length >= 200) break;
  }
  return list;
}

/** Returns the keyword that fired, '*' for "any message" mode, or null. */
export function matchTrigger(text, settings) {
  const body = normalizeText(text);
  if (!body) return null;
  if (settings?.matchAny) return '*';
  for (const kw of parseKeywords(settings?.keywords)) {
    if (body.includes(kw.norm)) return kw.shown;
  }
  return null;
}
