'use strict';

// On-site register discovery tool.
//   node scan.js <host> [startReg] [count] [unitId]
// e.g.
//   node scan.js 192.168.1.2 0 20
//
// Tries holding registers first, then input registers, then coils.
// Compare FLOAT32 columns against the FXA42 Grid View to find register + word order.

const ModbusRTU = require('modbus-serial');
const { decode } = require('./modbus');

const TYPES = [
  { name: 'holding registers', read: (c, s, n) => c.readHoldingRegisters(s, n) },
  { name: 'input registers', read: (c, s, n) => c.readInputRegisters(s, n) },
  { name: 'coils', read: (c, s, n) => c.readCoils(s, n) },
];

function printFloatTable(start, regs) {
  const count = regs.length;
  console.log('reg   raw      |  FLOAT32 as pair (this reg + next)');
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
}

function printCoilTable(start, coils) {
  console.log('coil   value');
  console.log('-'.repeat(16));
  for (let i = 0; i < coils.length; i++) {
    console.log(`${String(start + i).padStart(4)}  ${coils[i] ? 1 : 0}`);
  }
}

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
  client.setTimeout(5000);

  console.log(`\nConnecting to ${host}:502 (unit ${unitId})...`);
  try {
    await client.connectTCP(host, { port: 502 });
  } catch (err) {
    console.error(`TCP connect failed: ${err.message}`);
    console.error('Check: on filter WiFi? Gateway powered? Modbus TCP enabled on FXA42 web UI?');
    process.exit(1);
  }
  client.setID(unitId);
  console.log('TCP connected.\n');

  for (const type of TYPES) {
    console.log(`--- ${type.name} ${start}..${start + count - 1} ---\n`);
    try {
      const result = await type.read(client, start, count);
      const data = result.data;
      if (type.name === 'coils') {
        printCoilTable(start, data);
      } else {
        printFloatTable(start, data);
      }
      client.close(() => process.exit(0));
      return;
    } catch (err) {
      console.error(`read failed: ${err.message}\n`);
    }
  }

  console.error('No readable registers/coils in this range.');
  console.error('On the FXA42 web UI (http://' + host + '):');
  console.error('  1. Enable Modbus TCP server');
  console.error('  2. Map each analog/digital value to a register address');
  console.error('  3. Note the unit ID and re-run: node scan.js ' + host + ' <start> <count> <unitId>');
  client.close(() => process.exit(1));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
