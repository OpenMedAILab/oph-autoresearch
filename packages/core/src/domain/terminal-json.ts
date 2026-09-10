/** Parse one complete terminal JSON object without extracting a later, contradictory answer. */
export function parseTerminalJson(output: string): Record<string, unknown> {
  if (output.length > 256_000) throw new Error('Output exceeds JSON contract limit')
  const start = output.indexOf('{')
  if (start < 0) throw new Error('Output must end with one JSON object')
  const source = output
    .slice(start)
    .trim()
    .replace(/\n```\s*$/, '')
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('Output must end with one complete JSON object')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected JSON object')
  return value as Record<string, unknown>
}
