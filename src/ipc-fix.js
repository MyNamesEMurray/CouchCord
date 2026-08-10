"use strict";

const { IPCTransport } = require("@xhayper/discord-rpc/dist/transport/IPC");

const OP = { FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

// @xhayper/discord-rpc's IPC read loop drains the socket and then requires
// the buffer to be EXACTLY one message long; whenever Discord's writes
// coalesce into a single read (routine on Windows named pipes, e.g. the
// response burst right after AUTHENTICATE), the stashed buffer can never
// match again and message processing dies permanently: commands still reach
// Discord but responses, events and keepalive PINGs are never seen again,
// until Discord gives up and closes the pipe (~1 minute). Observed in the
// field as a connected-but-deaf session whose panel actions "fail" late
// with "Closed by Discord".
//
// This subclass replaces the read handler with an incremental frame parser
// after the handshake completes. The swap is race-free in practice: Discord
// sends nothing between READY (which resolves connect()) and our first
// request. ponytail: delete this file when the framing is fixed upstream.
class FramingFixedIPCTransport extends IPCTransport {
  async connect() {
    await super.connect();
    const socket = this.socket;
    if (!socket) return;

    socket.removeAllListeners("readable");
    // Adopt anything the broken handler already stashed as "partial".
    let buf = this.tmpData && this.tmpData.data ? this.tmpData.data : Buffer.alloc(0);
    this.tmpData = null;

    const pump = () => {
      let chunk;
      while ((chunk = socket.read()) !== null) {
        buf = Buffer.concat([buf, chunk]);
      }
      while (buf.length >= 8) {
        const op = buf.readUInt32LE(0);
        const length = buf.readUInt32LE(4);
        if (buf.length < 8 + length) break; // genuine partial frame — wait for more
        const body = buf.subarray(8, 8 + length).toString();
        buf = buf.subarray(8 + length);
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          continue; // skip malformed frame rather than poisoning the stream
        }
        switch (op) {
          case OP.FRAME:
            this.emit("message", parsed);
            break;
          case OP.CLOSE:
            this.emit("close", parsed);
            break;
          case OP.PING:
            this.send(parsed, OP.PONG);
            this.emit("ping");
            break;
        }
      }
    };

    socket.on("readable", pump);
    pump(); // drain whatever arrived before the swap
  }
}

module.exports = { FramingFixedIPCTransport };
