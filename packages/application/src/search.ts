export const TOKENIZER_VERSION = 'zh-bigram-code-v1'
const normalize = (s: string) => s.normalize('NFKC').toLowerCase()
export function tokenize(
  text: string,
  dictionary: readonly string[] = [],
): string[] {
  const normalized = normalize(text)
  const tokens = new Set<string>()
  for (const word of dictionary) {
    if (word.length <= 128 && normalized.includes(normalize(word)))
      tokens.add(normalize(word))
  }
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = Array.from(run)
    if (chars.length === 1) tokens.add(run)
    else
      for (let i = 0; i < chars.length - 1; i++)
        tokens.add(chars[i]! + chars[i + 1]!)
  }
  const separated = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  for (const run of normalize(separated).match(/[a-z0-9]+/g) ?? [])
    tokens.add(run)
  return [...tokens].filter((t) => t.length <= 128).sort()
}
export function identifiers(text: string): string[] {
  return [
    ...new Set(
      (text.match(/[A-Za-z0-9][A-Za-z0-9_./:#-]*/g) ?? []).map(normalize),
    ),
  ].filter((t) => t.length <= 256)
}
export function searchTerms(query: string): {
  terms: string[]
  exact: string
  match: string
} {
  if (new TextEncoder().encode(query).length > 4096)
    throw new Error('QUERY_TOO_LARGE')
  const terms = tokenize(query)
  if (terms.length > 32) throw new Error('TOO_MANY_QUERY_TERMS')
  // User input is never an FTS expression. Each generated token is a quoted literal.
  return {
    terms,
    exact: normalize(query.trim()),
    match: terms.map((t) => '"' + t.replaceAll('"', '""') + '"').join(' OR '),
  }
}
