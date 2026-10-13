import { randomBytes } from "node:crypto";
import { connect } from "node:net";

// The smallest WebSocket client that sherpa-onnx's offline server needs: one binary message out, one text reply back.
// (Electron 33's Node 20 has no stable global WebSocket, and no npm dependency is wanted for this.)

export function encodeFrame(opcode: number, payload: Buffer, mask: Buffer = randomBytes(4)): Buffer {
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  if (len < 126) head[1] = 0x80 | len;
  else if (len < 65536) { head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
  else { head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(len), 2); }
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

/** Parses complete (unmasked, server → client) frames from `buf`; returns them and the unparsed rest. */
export function decodeFrames(buf: Buffer): { frames: { fin: boolean; opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { fin: boolean; opcode: number; payload: Buffer }[] = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const fin = (buf[off] & 0x80) !== 0, opcode = buf[off] & 0x0f, masked = (buf[off + 1] & 0x80) !== 0;
    let len = buf[off + 1] & 0x7f, p = off + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const mask = masked ? buf.subarray(p, p + 4) : null;
    if (masked) p += 4;
    if (p + len > buf.length) break;
    let payload = buf.subarray(p, p + len);
    if (mask) payload = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
    frames.push({ fin, opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/** Sends one binary message to ws://127.0.0.1:port/ and resolves with the first text message back. */
export function wsRequest(port: number, message: Buffer, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0), upgraded = false, done = false, text: Buffer[] = [];
    const finish = (err: Error | null, value?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!err) {
        // sherpa's clients say "Done" when they have their result; then close politely.
        try { sock.write(encodeFrame(1, Buffer.from("Done"))); sock.write(encodeFrame(8, Buffer.alloc(0))); } catch {}
        sock.end();
        resolve(value!);
      } else { sock.destroy(); reject(err); }
    };
    const timer = setTimeout(() => finish(new Error("timed out")), timeoutMs);
    sock.on("connect", () => {
      sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const status = buf.subarray(0, end).toString();
        if (!/^HTTP\/1\.1 101/.test(status)) return finish(new Error(status.split("\r\n")[0]));
        upgraded = true;
        buf = buf.subarray(end + 4);
        sock.write(encodeFrame(2, message));
      }
      const { frames, rest } = decodeFrames(buf);
      buf = Buffer.from(rest);
      for (const f of frames) {
        if (f.opcode === 9) sock.write(encodeFrame(10, f.payload));
        else if (f.opcode === 8) finish(new Error("closed by server"));
        else if (f.opcode === 1 || (f.opcode === 0 && text.length)) {
          text.push(f.payload);
          if (f.fin) { finish(null, Buffer.concat(text).toString("utf8")); text = []; }
        }
      }
    });
    sock.on("error", (e) => finish(e));
    sock.on("close", () => finish(new Error("connection closed")));
  });
}
