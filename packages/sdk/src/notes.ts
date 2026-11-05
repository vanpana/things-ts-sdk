import { crc32 } from "./crc32.ts";
import { NoteError } from "./errors.ts";

export const NOTE_TYPE_FULL_TEXT = 1;
export const NOTE_TYPE_DELTA = 2;

/** One replacement. `p` and `l` are UTF-8 byte offsets, not characters. */
export interface NotePatch { r: string; p: number; l: number; ch: number }

export interface Note {
  _t: string;
  t: number;
  ch?: number;
  v?: string;
  ps?: NotePatch[];
}

const enc = new TextEncoder();

/** The only note shape this SDK writes: a full-text note with its CRC32. */
export function textNote(value: string): { _t: "tx"; ch: number; v: string; t: 1 } {
  return { _t: "tx", ch: crc32(value), v: value, t: 1 };
}

function splice(text: Uint8Array, patch: NotePatch): Uint8Array {
  const position = Math.min(Math.max(patch.p, 0), text.length);
  const length = Math.min(Math.max(patch.l, 0), text.length - position);
  const rep = enc.encode(patch.r);
  const out = new Uint8Array(position + rep.length + (text.length - position - length));
  out.set(text.subarray(0, position), 0);
  out.set(rep, position);
  out.set(text.subarray(position + length), position + rep.length);
  return out;
}

/** Applies byte-offset patches. Out-of-range positions and lengths are clamped; invalid UTF-8 is replaced. */
export function applyPatches(original: string, patches: NotePatch[]): string {
  let text: Uint8Array = enc.encode(original);
  for (const patch of patches) text = splice(text, patch);
  return new TextDecoder().decode(text);
}

/** Like {@link applyPatches}, but rejects a patch that leaves the note as invalid UTF-8. */
export function applyPatchesChecked(original: string, patches: NotePatch[]): string {
  if (!original.isWellFormed()) throw new NoteError("original note is not valid UTF-8");
  const strict = new TextDecoder("utf-8", { fatal: true });
  let text: Uint8Array = enc.encode(original);
  for (const [i, patch] of patches.entries()) {
    text = splice(text, patch);
    try { strict.decode(text); } catch { throw new NoteError(`note patch ${i} produced invalid UTF-8`); }
  }
  return strict.decode(text);
}
