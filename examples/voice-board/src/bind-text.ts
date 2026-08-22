import { markdown } from "@codemirror/lang-markdown";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import type { CollabText } from "collabnode";

/**
 * Notes are prose, so this is deliberately not `basicSetup`: no line-number
 * gutter, no fold gutter, no active-line highlight, and — the one that actually
 * hurt — line wrapping on, so a dictated sentence stays on screen.
 */
const PROSE_SETUP = [
  history(),
  drawSelection(),
  EditorView.lineWrapping,
  keymap.of([...defaultKeymap, ...historyKeymap]),
  placeholder("Start typing, or tap the mic and say what you want written down."),
];

export function bindCollabText(parent: HTMLElement, text: CollabText): { destroy(): void } {
  let applying = false;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text.toString(),
      extensions: [
        PROSE_SETUP,
        markdown(),
        EditorView.updateListener.of((update) => {
          if (applying || !update.docChanged) {
            return;
          }
          applying = true;
          const ops: Array<{ from: number; to: number; insert: string }> = [];
          update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            ops.push({ from: fromA, to: toA, insert: inserted.toString() });
          });
          try {
            for (const op of ops.reverse()) {
              if (op.to > op.from) {
                text.delete(op.from, op.to - op.from);
              }
              if (op.insert) {
                text.insert(op.from, op.insert);
              }
            }
          } finally {
            applying = false;
          }
        }),
      ],
    }),
  });

  const syncFromCollab = (): void => {
    const next = text.toString();
    if (view.state.doc.toString() === next) {
      return;
    }
    applying = true;
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    } finally {
      applying = false;
    }
  };

  const stop = text.observe(syncFromCollab);
  const retries = [0, 50, 150, 400, 1000].map((ms) => setTimeout(syncFromCollab, ms));
  void text.flushed?.().then(syncFromCollab);

  return {
    destroy() {
      for (const timer of retries) {
        clearTimeout(timer);
      }
      stop();
      view.destroy();
    },
  };
}
