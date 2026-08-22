export function toolName(prefix: string, type: string): string {
  const cleaned = type.replace(/[^A-Za-z0-9_]/g, "_");
  return `${prefix}_${cleaned}`;
}

export function promptName(prefix: string, type: string): string {
  return `${prefix}-${type.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
