// A file (or byte range of it) as a web ReadableStream for route responses. Server-only.
//
// Not Node's Readable.toWeb: when the browser cancels a download (a <video> seeking or
// switching source does this all the time), toWeb can still push a chunk into the
// closed stream and throw "Invalid state: Controller is already closed" as an uncaught
// exception, which kills the whole server. Here a cancel just stops reading the file.
import { createReadStream, type ReadStream } from "node:fs";

export function fileStream(filePath: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
  let file: ReadStream | null = null;
  let done = false;
  const finish = () => { done = true; file?.destroy(); };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      file = createReadStream(filePath, { ...range, highWaterMark: 256 * 1024 });
      file.on("data", chunk => {
        if (done) return;
        try {
          controller.enqueue(new Uint8Array(chunk as Buffer));
        } catch {
          finish(); // the response was closed under us
          return;
        }
        if ((controller.desiredSize ?? 1) <= 0) file?.pause(); // let the browser catch up
      });
      file.on("end", () => { if (done) return; done = true; try { controller.close(); } catch { /* already closed */ } });
      file.on("error", err => { if (done) return; done = true; try { controller.error(err); } catch { /* already closed */ } });
    },
    pull() { if (!done) file?.resume(); },
    cancel() { finish(); },
  }, { highWaterMark: 4 }); // at most ~1 MB buffered per response
}
