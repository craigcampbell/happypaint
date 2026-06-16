// Web Worker that runs the synchronous GIF89a encoder off the main thread so
// exporting a loop never freezes the tab. The main thread composites each frame
// to an ImageData at the final GIF size and posts the raw RGBA buffers here
// (transferred, not copied); we hand them straight to encodeGif (which short-
// circuits toImageData when the ImageData is already the target size, so no DOM
// APIs are touched inside the worker).

import { encodeGif } from "./gif";

self.onmessage = (event) => {
  const { id, width, height, frames } = event.data || {};

  try {
    const sources = frames.map((frame) => ({
      source: {
        data: new Uint8ClampedArray(frame.buffer),
        width: frame.width,
        height: frame.height,
      },
      delayMs: frame.delayMs,
    }));

    const bytes = encodeGif(sources, { width, height });
    // Transfer the encoded bytes back to avoid a copy.
    self.postMessage({ id, ok: true, bytes }, [bytes.buffer]);
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
};
