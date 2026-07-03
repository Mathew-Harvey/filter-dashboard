'use strict';

// A stand-in FXA42 for testing the poller/dashboard without hardware.
//   node mock-slave.js <port> <analog|digital>
// Serves FLOAT32 values (analog) or 0/1 flags (digital) in holding registers,
// with slow variation so the dashboard shows live movement.

const ModbusRTU = require('modbus-serial');

const port = Number(process.argv[2] || 5021);
const kind = process.argv[3] || 'analog';

function holdingRegister(addr) {
  const t = Date.now() / 1000;
  if (kind === 'analog') {
    // Four floats at register pairs 0,2,4,6. Vary each slightly.
    const values = [
      120 + 30 * Math.sin(t / 20),  // flow ~90-150
      2.5 + 1.5 * Math.sin(t / 13),  // turbidity
      0.8 + 0.3 * Math.sin(t / 7),   // pressure
      260 + 40 * Math.sin(t / 30),   // ORP
    ];
    const pair = Math.floor(addr / 2);
    const v = values[pair] ?? 0;
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(v, 0); // ABCD / big-endian
    return addr % 2 === 0 ? buf.readUInt16BE(0) : buf.readUInt16BE(2);
  }
  // digital: reg 0 occasionally faults, rest clear
  if (addr === 0) return Math.sin(t / 15) > 0.9 ? 1 : 0;
  return 0;
}

const vector = {
  getHoldingRegister: (addr, _unitID, cb) => cb(null, holdingRegister(addr)),
  getInputRegister: (addr, _unitID, cb) => cb(null, holdingRegister(addr)),
  getCoil: (addr, _unitID, cb) => cb(null, holdingRegister(addr) === 1),
};

new ModbusRTU.ServerTCP(vector, { host: '0.0.0.0', port, unitID: 1, debug: false });
console.log(`[mock ${kind}] Modbus TCP slave listening on ${port}`);
