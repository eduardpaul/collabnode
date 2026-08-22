import { TinyliciousClient } from "@fluidframework/tinylicious-client";
import { SharedString } from "fluid-framework/legacy";
import {
  SharedTree,
  type ContainerSchema,
  type IFluidContainer,
} from "fluid-framework";

export const fluidContainerSchema = {
  initialObjects: {
    graph: SharedTree,
    collab: SharedTree,
  },
  dynamicObjectTypes: [SharedString],
} satisfies ContainerSchema;

export interface TinyliciousOptions {
  domain?: string;
  port?: number;
}

export function createTinyliciousClient(options: TinyliciousOptions = {}): TinyliciousClient {
  return new TinyliciousClient({
    connection: {
      domain: options.domain ?? "http://localhost",
      port: options.port ?? 7070,
    },
  });
}

export async function createTinyliciousContainer(
  client: TinyliciousClient,
): Promise<{ container: IFluidContainer; id: string }> {
  const { container } = await client.createContainer(fluidContainerSchema, "2");
  const id = await container.attach();
  return { container, id };
}

export async function loadTinyliciousContainer(
  client: TinyliciousClient,
  id: string,
): Promise<IFluidContainer> {
  const { container } = await client.getContainer(id, fluidContainerSchema, "2");
  return container;
}
