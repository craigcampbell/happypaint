// Binary gzip frames on the room socket. The server keeps ONE gzipped history
// frame per room and hands it to every joiner as-is (see sendHistoryCatchUp in
// server.js) instead of stringifying + deflating the whole mural per join. A
// client advertises support with `gz=1` on the socket URL; anything it can't
// inflate simply never arrives (the server falls back to text).
//
// Decoding is async, so every message on the socket — text included — goes
// through one ordered chain: the tail ops the server sends right after the
// gzip frame must land AFTER the history they extend.

export function supportsGzipFrames() {
  return typeof DecompressionStream === "function" && typeof Response === "function" && typeof Blob === "function";
}

async function inflate(buffer) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

// Returns an `onmessage` handler that decodes text or gzip frames and calls
// `onText(text)` strictly in arrival order. `isLive()` lets a stale socket's
// late-decoded frames be dropped after a reconnect.
export function orderedFrameDecoder(onText, isLive = () => true) {
  let chain = Promise.resolve();
  return (event) => {
    const payload = event.data;
    chain = chain
      .then(async () => {
        let text = payload;
        if (payload instanceof ArrayBuffer) {
          text = await inflate(payload);
        } else if (typeof Blob !== "undefined" && payload instanceof Blob) {
          text = await inflate(await payload.arrayBuffer());
        }
        if (!isLive()) return;
        onText(text);
      })
      .catch(() => {
        // An undecodable frame is dropped; the chain keeps flowing.
      });
  };
}
