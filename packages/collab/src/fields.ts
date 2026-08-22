export interface CollabText {
  readonly kind: "text";
  toString(): string;
  insert(index: number, value: string): void;
  delete(index: number, length: number): void;
  replace(value: string): void;
  observe(listener: () => void): () => void;
  /** Wait until queued replace/insert/delete have been applied (Fluid lazy handles). */
  flushed?(): Promise<void>;
}

export interface CollabMap {
  readonly kind: "map";
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  toJSON(): Record<string, unknown>;
  replace(value: Record<string, unknown>): void;
  observe(listener: () => void): () => void;
}

export interface CollabArray {
  readonly kind: "array";
  toJSON(): unknown[];
  replace(value: unknown[]): void;
  push(value: unknown): void;
  observe(listener: () => void): () => void;
}

export function replaceText(target: { toString(): string; insert(i: number, v: string): void; delete(i: number, n: number): void }, value: string): void {
  const previous = target.toString();
  if (previous.length > 0) {
    target.delete(0, previous.length);
  }
  if (value.length > 0) {
    target.insert(0, value);
  }
}

export function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
