---
"@collabnode/react": minor
"@collabnode/web": minor
"collabnode": minor
---

`@collabnode/react`: hooks for a collabnode document in the browser — and the
connection now belongs to the component that opened it.

- **`useCollab` closes the session it opened** on unmount, and when pointed at
  another document. It previously dropped the `WebCollab` on the floor, leaking
  a container, a socket and a presence registration per mount — twice per mount
  under StrictMode. A connection that arrives after teardown is closed too.

- **`useCollabJoin(url, options)`** is new: fetch a join descriptor from the
  server, connect to what it describes. Every browser app was writing that pair
  by hand, because the document id, schema and relay coordinates are the
  server's to give.

- **`nodesByType`** on the result, so a view stops filtering the snapshot itself.

- The per-session snapshot store releases its `onChange` subscription when the
  last reader unmounts, instead of holding it for the life of the session.

- `useCollabNodeState` writes only the property it was given; an upsert merges
  into what is stored, so resending the rest of the bag from a snapshot added
  nothing.

Ships with a README, and with tests that mount and unmount the hooks under
jsdom — which is what makes the lifetime above something CI can see.
