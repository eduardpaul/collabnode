const VALUE_COLORS: Record<string, string> = {
  healthy: "#3dd68c",
  done: "#3dd68c",
  resolved: "#3dd68c",
  true: "#3dd68c",
  degraded: "#f5c542",
  doing: "#f5c542",
  mitigating: "#f5c542",
  sev2: "#f5c542",
  medium: "#f5c542",
  down: "#ff5d73",
  sev1: "#ff5d73",
  high: "#ff5d73",
  open: "#ff5d73",
  false: "#8b95ab",
  todo: "#6ea8fe",
  later: "#6ea8fe",
  sev3: "#6ea8fe",
  retail: "#6ea8fe",
  low: "#6ea8fe",
  now: "#f5c542",
  dropped: "#8b95ab",
  vip: "#c084fc",
};

export function hashColor(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hue = hash % 360;
  return `hsl(${hue} 58% 60%)`;
}

export function colorForValue(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "#6ea8fe";
  }
  const key = String(value).toLowerCase();
  return VALUE_COLORS[key] ?? hashColor(String(value));
}

export function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim());
}

export function darken(color: string, amount = 0.22): string {
  if (isHexColor(color) && (color.length === 7 || color.length === 4)) {
    const hex =
      color.length === 4
        ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
        : color;
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    const mix = (c: number) => Math.max(0, Math.round(c * (1 - amount)));
    return `#${mix(r).toString(16).padStart(2, "0")}${mix(g).toString(16).padStart(2, "0")}${mix(b)
      .toString(16)
      .padStart(2, "0")}`;
  }
  if (color.startsWith("hsl(")) {
    return color.replace(/(\d+(?:\.\d+)?)%\s*\)/, (_, light: string) => {
      const next = Math.max(18, Number(light) - amount * 100);
      return `${next}%)`;
    });
  }
  return color;
}
