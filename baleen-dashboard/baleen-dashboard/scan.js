'use strict';

// On-site register discovery tool.
//   node scan.js <host> [startReg] [count] [unitId]
// e.g.
//   node scan.js 192.168.1.2 0 20
//
// It reads a block of holding registers and prints, for each register pair,
// the raw uint16 values plus the FLOAT32 interpretation in all four word
// orders. Compare these against the live values shown in the FXA42 Grid View
// to work out which register holds which tag and which word order is correct.

const ModbusRTU = require('modbus-serial');
const { decode } = require('./modbus');

async function main() {
  const host = process.argv[2];
  const start = Number(process.argv[3] || 0);
  const count = Number(process.argv[4] || 20);
  const unitId = Number(process.argv[5] || 1);

  if (!host) {
    console.error('usage: node scan.js <host> [startReg=0] [count=20] [unitId=1]');
    process.exit(1);
  }

  const client = new ModbusRTU();
  client.setTimeout(3000);
  await client.connectTCP(host, { port: 502 });
  client.setID(unitId);

  console.log(`\nHolding registers ${start}..${start + count - 1} on ${host} (unit ${unitId})\n`);

  let regs;
  try {
    regs = (await client.readHoldingRegisters(start, count)).data;
  } catch (err) {
    console.error(`read failed: ${err.message}`);
    console.error('If holding registers fail, the values may be mapped as input registers or coils.');
    client.close(() => process.exit(1));
    return;
  }

  console.log('reg   uint16   |  FLOAT32 as pair (this reg + next)');
  console.log('               |    ABCD          DCBA          CDAB          BADC');
  console.log('-'.repeat(78));

  for (let i = 0; i < count; i++) {
    const addr = start + i;
    const raw = regs[i];
    let floats = '';
    if (i + 1 < count) {
      const buf = Buffer.alloc(4);
      buf.writeUInt16BE(regs[i], 0);
      buf.writeUInt16BE(regs[i + 1], 2);
      const fmt = (o) => {
        const v = decode(buf, 'FLOAT32', o);
        return Number.isFinite(v) ? v.toPrecision(6).padStart(12) : '         n/a';
      };
      floats = `${fmt('ABCD')}  ${fmt('DCBA')}  ${fmt('CDAB')}  ${fmt('BADC')}`;
    }
    console.log(`${String(addr).padStart(4)}  ${String(raw).padStart(6)}   | ${floats}`);
  }

  console.log('\nTip: a plausible engineering value in exactly one column tells you the word order.');
  client.close(() => process.exit(0));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
