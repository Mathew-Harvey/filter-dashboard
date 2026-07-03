'use strict';

// Fast on-site diagnostic — run this first on filter WiFi.
//   node probe.js                  # all gateways from config.js
//   node probe.js 192.168.1.2
//
// Tells you: TCP reachability, whether ANY Modbus register responds,
// and what to fix on the FXA42 web UI if nothing is published yet.

const ModbusRTU = require('modbus-serial');
const config = require('./config.js');

const CHANNEL_MAP = {
  'FXA42-1': {
    host: '192.168.1.2',
    modbusUrl: 'http://192.168.1.2',
    analogChannels: [
      { ch: 0, tag: 'FLM-W', name: 'Water flow rate', unit: 'm³/h', suggestReg: 0 },
      { ch: 1, tag: 'TUR', name: 'Turbidity', unit: 'NTU', suggestReg: 2 },
      { ch: 2, tag: 'BFP', name: 'Bag filter pressure', unit: 'bar', suggestReg: 4 },
      { ch: 3, tag: 'ORP', name: 'Redox potential', unit: 'mV', suggestReg: 6 },
    ],
  },
  'FXA42-2': {
    host: '192.168.1.3',
    modbusUrl: 'http://192.168.1.3',
    digitalChannels: [
      { ch: 0, tag: 'COM-F', name: 'Compressor fault', suggestReg: 0 },
      { ch: 1, tag: 'BAL-F', name: 'Baleen filter fault', suggestReg: 1 },
      { ch: 2, tag: 'UVM-F', name: 'UV module fault', suggestReg: 2 },
      { ch: 3, tag: 'PLN-F', name: 'General plant fault', suggestReg: 3 },
    ],
  },
  'FXA42-3': {
    host: '192.168.1.4',
    modbusUrl: 'http://192.168.1.4',
    analogChannels: [
      { ch: 0, tag: 'BOT-L', name: 'Bow tank level', unit: '%', suggestReg: 0 },
      { ch: 1, tag: 'C2T-L', name: 'C20 tank level', unit: '%', suggestReg: 2 },
      { ch: 2, tag: 'UVI', name: 'UV intensity', unit: '%', suggestReg: 4 },
      { ch: 3, tag: 'FLM-A', name: 'Compressed air flow', unit: 'm³/h', suggestReg: 6 },
    ],
  },
};

const READERS = [
  { key: 'holding', fn: (c, a, n) => c.readHoldingRegisters(a, n) },
  { key: 'input', fn: (c, a, n) => c.readInputRegisters(a, n) },
  { key: 'coil', fn: (c, a, n) => c.readCoils(a, n) },
];

async function tryRead(client, reader, addr) {
  try {
    const n = reader.key === 'coil' ? 8 : 2;
    const r = await reader.fn(client, addr, n);
    return { ok: true, data: r.data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function scanForAny(client, unitId, maxReg) {
  client.setID(unitId);
  const found = [];

  // Coils (digital gateways) — check each address 0-3
  for (let addr = 0; addr < Math.min(maxReg, 8); addr++) {
    const r = await tryRead(client, READERS[2], addr);
    if (r.ok) found.push({ unitId, type: 'coil', addr, sample: r.data.slice(0, 4).map((b) => b ? 1 : 0) });
  }

  for (const reader of READERS.slice(0, 2)) {
    for (let addr = 0; addr < maxReg; addr += 2) {
      const r = await tryRead(client, reader, addr);
      if (r.ok) found.push({ unitId, type: reader.key, addr, sample: r.data.slice(0, 4) });
    }
  }
  return found;
}

function printSetupGuide(gw) {
  const map = CHANNEL_MAP[gw.id];
  if (!map) return;

  console.log('\n  ┌─ FXA42 MODBUS SERVER SETUP REQUIRED ─────────────────────────────');
  console.log('  │ Channel config (Grid View) ≠ Modbus publish. You must ALSO add');
  console.log('  │ output values on Settings → Modbus Server/Slave, then RESTART.');
  console.log('  │');
  console.log(`  │ 1. Browser → ${map.modbusUrl}  (login: super / super)`);
  console.log('  │ 2. Settings → Modbus Server/Slave → Mode: Modbus TCP server');
  console.log('  │ 3. Port 502, Unit ID 1');
  console.log('  │ 4. Add one OUTPUT value per tag (Edit value → Add):');

  if (map.analogChannels) {
    for (const ch of map.analogChannels) {
      console.log(
        `  │    • ${ch.tag} (${ch.name}) — Analog Input ${ch.ch} → `
        + `holding reg ${ch.suggestReg}, FLOAT32, 2 registers`
      );
    }
  }
  if (map.digitalChannels) {
    for (const ch of map.digitalChannels) {
      console.log(
        `  │    • ${ch.tag} (${ch.name}) — Digital Input ${ch.ch} → `
        + `coil or holding reg ${ch.suggestReg}`
      );
    }
  }

  console.log('  │ 5. Restart device (required after Modbus changes)');
  console.log('  │ 6. Confirm values appear in Grid View as Modbus outputs');
  console.log('  │ 7. Re-run:  node probe.js ' + gw.host);
  console.log('  │            node discover.js ' + gw.host);
  console.log('  └──────────────────────────────────────────────────────────────────');
}

async function probeGateway(gw) {
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`${gw.id}  @  ${gw.host}:${gw.port || 502}`);
  console.log('═'.repeat(72));

  const client = new ModbusRTU();
  client.setTimeout(4000);

  try {
    await client.connectTCP(gw.host, { port: gw.port || 502 });
    console.log('TCP port 502:  OK (gateway reachable)');
  } catch (err) {
    console.log(`TCP port 502:  FAILED — ${err.message}`);
    if (gw.host === '192.168.1.4') {
      console.log('  → FXA42-3 was unpowered on 16 May 2026. Check 24 V terminals.');
    } else {
      console.log('  → Check filter WiFi, gateway power, Ethernet link.');
    }
    return;
  }

  // Quick probe — try coils first for digital gateways, then holding registers
  client.setID(gw.unitId || 1);
  const isDigitalGw = gw.tags?.every((t) => t.type === 'digital');

  if (isDigitalGw) {
    const coilProbe = await tryRead(client, READERS[2], 0);
    if (coilProbe.ok) {
      console.log(`Modbus read @ unit ${gw.unitId || 1}, coils 0-3:  OK  [${coilProbe.data.slice(0, 4).map((b) => b ? 1 : 0).join(', ')}]`);
      console.log('  → Digital Modbus publish is working (coils). Dashboard should read these.');
    } else {
      console.log(`Modbus read @ unit ${gw.unitId || 1}, coils 0:  ${coilProbe.error}`);
      console.log('  → Check: Modbus outputs saved? Web-PLC started? Gateway restarted?');
    }
  } else {
    const probe = await tryRead(client, READERS[0], 0);
    if (!probe.ok) {
      console.log(`Modbus read @ unit ${gw.unitId || 1}, holding reg 0:  ${probe.error}`);
    } else {
      console.log(`Modbus read @ unit ${gw.unitId || 1}, holding reg 0:  OK  raw=${probe.data.join(',')}`);
    }
  }

  process.stdout.write('Scanning coils 0-3 and registers 0-19... ');
  const found = await scanForAny(client, gw.unitId || 1, isDigitalGw ? 4 : 20);
  console.log(found.length ? `found ${found.length}` : 'none');

  if (found.length) {
    console.log('\nReadable addresses:');
    for (const f of found.slice(0, 15)) {
      console.log(`  unit ${f.unitId}  ${f.type.padEnd(8)} reg ${f.addr}  sample [${f.sample.join(', ')}]`);
    }
    if (found.length > 15) console.log(`  ... and ${found.length - 15} more`);
    console.log('\nNext: node discover.js ' + gw.host);
  } else if (!isDigitalGw) {
    console.log('\nVERDICT: Gateway online, Modbus TCP open, but zero published registers.');
    printSetupGuide(gw);
  } else {
    console.log('\nVERDICT: Coils not readable — save Web-PLC diagram and Start PLC, then restart gateway.');
    printSetupGuide(gw);
  }

  client.close(() => {});
}

async function main() {
  const hosts = process.argv.slice(2).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const gateways = hosts.length
    ? config.gateways.filter((g) => hosts.includes(g.host))
    : config.gateways;

  if (!gateways.length) {
    console.error('usage: node probe.js [host...]');
    process.exit(1);
  }

  console.log('[baleen-probe] FXA42 connectivity + Modbus publish check');
  for (const gw of gateways) await probeGateway(gw);
  console.log('\nGrid View works in browser but dashboard shows "no data"?');
  console.log('That confirms channels are configured but Modbus outputs are not.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
