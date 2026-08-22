const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

export function attrEnabled(el: HTMLElement, name: string, defaultOn = true): boolean {
  if (!el.hasAttribute(name)) {
    return defaultOn;
  }
  const value = el.getAttribute(name);
  return value !== "false" && value !== "0";
}
