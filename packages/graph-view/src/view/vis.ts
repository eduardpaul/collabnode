import * as vis from "vis-network/standalone";

export interface VisDataset<T extends { id: string }> {
  add(data: T | T[]): void;
  update(data: T | T[] | (Partial<T> & { id: string }) | Array<Partial<T> & { id: string }>): void;
  remove(id: string | string[]): void;
  clear(): void;
}

export interface VisClickParams {
  nodes?: (string | number)[];
  edges?: (string | number)[];
  event?: { srcEvent?: MouseEvent };
}

export interface VisNetwork {
  destroy(): void;
  fit(opts?: Record<string, unknown>): void;
  setOptions(opts: Record<string, unknown>): void;
  getPositions(ids?: string[]): Record<string, { x: number; y: number }>;
  on(event: string, handler: (params: VisClickParams) => void): void;
  unselectAll(): void;
  getSelectedNodes(): (string | number)[];
  getSelectedEdges(): (string | number)[];
}

type DataSetCtor = new <T extends { id: string }>(data?: T[]) => VisDataset<T>;
type NetworkCtor = new (
  container: HTMLElement,
  data: { nodes: VisDataset<{ id: string }>; edges: VisDataset<{ id: string }> },
  options?: Record<string, unknown>,
) => VisNetwork;

const bundled = vis as unknown as { DataSet: DataSetCtor; Network: NetworkCtor };

export const DataSet = bundled.DataSet;
export const Network = bundled.Network;
