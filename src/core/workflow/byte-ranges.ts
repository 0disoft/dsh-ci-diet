import type { Node } from "yaml";
import type { ByteRange } from "./model.ts";

export type ByteRangeReader = (node: Node | null | undefined) => ByteRange | null;

/** One parser-owned index; ASCII needs no table, and nothing survives the parse. */
export function createByteRangeReader(text: string, utf8Length: number): ByteRangeReader {
  let offsets: Uint32Array | undefined;
  if (utf8Length !== text.length) {
    offsets = new Uint32Array(text.length + 1);
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
      const unit = text.charCodeAt(index);
      const next = text.charCodeAt(index + 1);
      if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        // A prefix ending between the pair encodes the high surrogate as U+FFFD.
        offsets[index + 1] = bytes + 3;
        bytes += 4;
        index += 1;
      } else {
        // Lone surrogates also encode as the three-byte replacement character.
        bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
      }
      offsets[index + 1] = bytes;
    }
  }
  return (node) => {
    const range = node?.range;
    if (!range) return null;
    const [start, end] = range;
    return {
      startByte: offsets === undefined ? start : offsets[start]!,
      endByte: offsets === undefined ? end : offsets[end]!,
    };
  };
}
