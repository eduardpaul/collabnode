export function extractJson<T = any>(text: string): T {
  const trimmed = text.trim();

  // Try direct parse
  try {
    return JSON.parse(trimmed);
  } catch {}

  // Try extracting code block ```json ... ```
  const blockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (blockMatch && blockMatch[1]) {
    try {
      return JSON.parse(blockMatch[1].trim());
    } catch {}
  }

  // Try finding first { and last }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  throw new Error(`Could not parse JSON from model output: ${trimmed.slice(0, 100)}...`);
}
