import { SchemaFactory } from "fluid-framework";

export const collabFactory = new SchemaFactory("collabnode.collab.v1");

export class CollabJsonMap extends collabFactory.object("CollabJsonMap", {
  entries: collabFactory.map(collabFactory.string),
}) {}

export class CollabJsonArray extends collabFactory.object("CollabJsonArray", {
  items: collabFactory.array(collabFactory.string),
}) {}

export class CollabNodeRecord extends collabFactory.object("CollabNodeRecord", {
  texts: collabFactory.map(collabFactory.handle),
  maps: collabFactory.map(CollabJsonMap),
  arrays: collabFactory.map(CollabJsonArray),
}) {}

export class CollabDocument extends collabFactory.object("CollabDocument", {
  nodes: collabFactory.map(CollabNodeRecord),
}) {}
