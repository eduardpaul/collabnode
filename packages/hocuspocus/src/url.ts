export const DEFAULT_HOCUSPOCUS_PORT = 1234;

export function hocuspocusUrl(port: number = DEFAULT_HOCUSPOCUS_PORT): string {
  return `ws://127.0.0.1:${port}`;
}
