'use strict';

const ModbusRTU = require('modbus-serial');

// Rearrange the 4 raw bytes (read big-endian: reg0 = bytes 0-1, reg1 = bytes 2-3)
// into the requested word/byte order, then read as a big-endian float/int.
function reorder(buf, order) {
  const b = [buf[0], buf[1], buf[2], buf[3]];
  switch (order) {
    case 'ABCD': return Buffer.from([b[0], b[1], b[2], b[3]]); // big-endian
    case 'DCBA': return Buffer.from([b[3], b[2], b[1], b[0]]); // little-endian
    case 'CDAB': return Buffer.from([b[2], b[3], b[0], b[1]]); // big-endian word-swap
    case 'BADC': return Buffer.from([b[1], b[0], b[3], b[2]]); // little-endian byte-swap
    default: return Buffer.from([b[0], b[1], b[2], b[3]]);
  }
}

function decode(buffer, dataType, wordOrder) {
  switch (dataType) {
    case 'FLOAT32': return reorder(buffer, wordOrder).readFloatBE(0);
    case 'INT32': return reorder(buffer, wordOrder).readInt32BE(0);
    case 'UINT32': return reorder(buffer, wordOrder).readUInt32BE(0);
    case 'INT16': return buffer.readInt16BE(0);
    case 'UINT16': return buffer.readUInt16BE(0);
    default: throw new Error(`Unknown dataType: ${dataType}`);
  }
}

class Gateway {
  constructor(cfg, timeoutMs) {
    this.cfg = cfg;
    this.timeoutMs = timeoutMs;
    this.client = new ModbusRTU();
    this.connected = false;
  }

  async connect() {
    if (this.connected) return;
    await this.client.connectTCP(this.cfg.host, { port: this.cfg.port });
    this.client.setID(this.cfg.unitId);
    this.client.setTimeout(this.timeoutMs);
    this.connected = true;
  }

  // Drop the connection so the next poll cycle reconnects cleanly.
  reset() {
    this.connected = false;
    try { this.client.close(() => {}); } catch { /* ignore */ }
    this.client = new ModbusRTU();
  }

  async readTag(tag) {
    if (tag.type === 'digital') {
      if (tag.fn === 'coil') {
        const r = await this.client.readCoils(tag.register, 1);
        let v = r.data[0] ? 1 : 0;
        return tag.invert ? 1 - v : v;
      }
      // default: digital state held in a holding register as 0/1
      const r = await this.client.readHoldingRegisters(tag.register, 1);
      let v = r.data[0] ? 1 : 0;
      return tag.invert ? 1 - v : v;
    }

    // analog
    const len = tag.dataType === 'INT16' || tag.dataType === 'UINT16' ? 1 : 2;
    const r = await this.client.readHoldingRegisters(tag.register, len);
    let value = decode(r.buffer, tag.dataType, tag.wordOrder);
    if (tag.rescale) {
      const s = tag.rescale;
      value = s.outMin + ((value - s.inMin) * (s.outMax - s.outMin)) / (s.inMax - s.inMin);
    }
    return value;
  }

  // Poll every tag on this gateway sequentially (one client cannot do parallel reads).
  // Returns { key: { value, quality } } - quality is 'good' or 'bad'.
  async poll() {
    const out = {};
    try {
      await this.connect();
    } catch (err) {
      for (const tag of this.cfg.tags) out[tag.key] = { value: null, quality: 'bad', error: err.message };
      this.reset();
      return out;
    }
    for (const tag of this.cfg.tags) {
      try {
        const value = await this.readTag(tag);
        out[tag.key] = { value, quality: 'good' };
      } catch (err) {
        out[tag.key] = { value: null, quality: 'bad', error: err.message };
        // A failed read usually means the socket is gone - reset for next cycle.
        this.reset();
        break;
      }
    }
    return out;
  }
}

module.exports = { Gateway, decode, reorder };
