'use strict';

// Brute-force Modbus mapping discovery for FXA42 gateways.
//
//   node discover.js                         # all gateways in config.js
//   node discover.js 192.168.1.2             # one host
//   node discover.js 192.168.1.2 --digital   # force digital (coil/register) scan
//   node discover.js --max-reg 300 --units 1-10
//   node discover.js --watch 15              # re-run every 15s until Ctrl+C
//
// Tries: unit IDs, holding/input registers, coils, register addresses, word orders.
// Scores candidates against expected tag ranges and prints a suggested config snippet.

const ModbusRTU = require('modbus-serial');
const config = require('./config.js');
const { decode } = require('./modbus');

const CHANNEL_MAP = {
  'FXA42-1': { modbusUrl: 'http://192.168.1.2' },
  'FXA42-2': { modbusUrl: 'http://192.168.1.3' },
  'FXA42-3': { modbusUrl: 'http://192.168.1.4' },
};

const WORD_ORDERS = ['ABCD', 'DCBA', 'CDAB', 'BADC'];

// Expected engineering ranges per tag (for plausibility scoring).
const TAG_PROFILES = {
  'FLM-W': { min: 0, max: 250, sweet: [20, 180], unit: 'm³/h', type: 'analog' },
  'TUR': { min: 0, max: 50, sweet: [0, 10], unit: 'NTU', type: 'analog' },
  'BFP': { min: 0, max: 20, sweet: [0, 5], unit: 'bar', type: 'analog' },
  'ORP': { min: -1000, max: 1000, sweet: [100, 500], unit: 'mV', type: 'analog' },
  'UVI': { min: 0, max: 100, sweet: [40, 100], unit: '%', type: 'analog' },
  'BOT-L': { min: 0, max: 100, sweet: [5, 95], unit: '%', type: 'analog' },
  'C2T-L': { min: 0, max: 100, sweet: [5, 95], unit: '%', type: 'analog' },
  'FLM-A': { min: 0, max: 100, sweet: [0, 50], unit: 'm³/h', type: 'analog' },
  'COM-F': { type: 'digital' },
  'BAL-F': { type: 'digital' },
  'UVM-F': { type: 'digital' },
  'PLN-F': { type: 'digital' },
};

const REG_TYPES = [
  { key: 'holding', label: 'holding', analog: (c, a, n) => c.readHoldingRegisters(a, n), digital: (c, a) => c.readHoldingRegisters(a, 1) },
  { key: 'input', label: 'input', analog: (c, a, n) => c.readInputRegisters(a, n), digital: (c, a) => c.readInputRegisters(a, 1) },
  { key: 'coil', label: 'coil', analog: null, digital: (c, a) => c.readCoils(a, 1) },
];

function parseArgs(argv) {
  const opts = {
    hosts: [],
    digital: false,
    analog: false,
    maxReg: 200,
    unitMin: 1,
    unitMax: 5,
    block: 20,
    step: 2,
    timeout: 4000,
    watch: 0,
    stableDelayMs: 400,
    port: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--digital') opts.digital = true;
    else if (a === '--analog') opts.analog = true;
    else if (a === '--max-reg') opts.maxReg = Number(argv[++i]);
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--units') {
      const [lo, hi] = argv[++i].split('-').map(Number);
      opts.unitMin = lo;
      opts.unitMax = hi ?? lo;
    } else if (a === '--watch') opts.watch = Number(argv[++i] || 15);
    else if (a.startsWith('--')) {
      console.error(`Unknown option: ${a}`);
      process.exit(1);
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(a)) {
      opts.hosts.push(a);
    }
  }

  if (!opts.hosts.length) {
    opts.hosts = config.gateways.map((g) => g.host);
  }
  return opts;
}

function gatewayForHost(host) {
  return config.gateways.find((g) => g.host === host) || {
    id: host,
    host,
    port: 502,
    unitId: 1,
    tags: Object.keys(TAG_PROFILES).map((key) => ({
      key,
      name: key,
      type: TAG_PROFILES[key].type,
      unit: TAG_PROFILES[key].unit,
    })),
  };
}

function scoreAnalog(value, tagKey) {
  const p = TAG_PROFILES[tagKey];
  if (!p || p.type !== 'analog') return 0;
  if (!Number.isFinite(value)) return 0;
  if (Math.abs(value) > 1e6 || (Math.abs(value) > 0 && Math.abs(value) < 1e-6)) return 0;

  // Raw 4-20 mA (unit idle/not flowing — common on site May 2026).
  if (value >= 3.5 && value <= 22) return 0.55;

  if (value >= p.sweet[0] && value <= p.sweet[1]) return 1;
  if (value >= p.min && value <= p.max) return 0.65;
  return 0;
}

function floatCandidates(buf) {
  const out = [];
  for (const order of WORD_ORDERS) {
    const v = decode(buf, 'FLOAT32', order);
    if (Number.isFinite(v)) out.push({ dataType: 'FLOAT32', wordOrder: order, value: v });
  }
  const i16 = decode(buf, 'INT16', 'ABCD');
  const u16 = decode(buf, 'UINT16', 'ABCD');
  if (Number.isFinite(i16) && Math.abs(i16) < 32000) out.push({ dataType: 'INT16', wordOrder: 'ABCD', value: i16 });
  if (Number.isFinite(u16)) out.push({ dataType: 'UINT16', wordOrder: 'ABCD', value: u16 });
  return out;
}

async function connect(host, port, timeout) {
  const client = new ModbusRTU();
  client.setTimeout(timeout);
  await client.connectTCP(host, { port });
  return client;
}

// modbus-serial returns buffer on readHoldingRegisters - need single read
async function readAnalogPair(client, regType, addr) {
  try {
    const r = await regType.analog(client, addr, 2);
    const buf = r.buffer || Buffer.from([
      (r.data[0] >> 8) & 0xff, r.data[0] & 0xff,
      (r.data[1] >> 8) & 0xff, r.data[1] & 0xff,
    ]);
    return { ok: true, buf, raw: r.data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function readDigital(client, regType, addr) {
  try {
    const r = await regType.digital(client, addr);
    const v = regType.key === 'coil' ? (r.data[0] ? 1 : 0) : (r.data[0] ? 1 : 0);
    if (v !== 0 && v !== 1) return { ok: false, error: 'not binary' };
    return { ok: true, value: v };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function verifyStable(client, regType, addr, firstValue, isDigital, stableDelayMs) {
  await new Promise((r) => setTimeout(r, stableDelayMs));
  if (isDigital) {
    const r = await readDigital(client, regType, addr);
    return r.ok && r.value === firstValue;
  }
  const r = await readAnalogPair(client, regType, addr);
  if (!r.ok) return false;
  const cands = floatCandidates(r.buf);
  return cands.some((c) => Math.abs(c.value - firstValue) < Math.max(0.05 * Math.abs(firstValue), 0.01));
}

async function probeAnalog(client, gw, opts) {
  const analogTags = gw.tags.filter((t) => t.type === 'analog');
  const hits = [];

  for (let unitId = opts.unitMin; unitId <= opts.unitMax; unitId++) {
    client.setID(unitId);

    for (const regType of REG_TYPES) {
      if (!regType.analog) continue;

      // Coarse pass: find any readable addresses.
      const readable = [];
      process.stdout.write(`  unit ${unitId} ${regType.key}: scanning 0..${opts.maxReg - 1}... `);
      for (let addr = 0; addr < opts.maxReg; addr += opts.step) {
        const r = await readAnalogPair(client, regType, addr);
        if (r.ok) readable.push(addr);
      }
      console.log(readable.length ? `${readable.length} addresses` : 'none');
      if (!readable.length) continue;

      for (const addr of readable) {
        const r = await readAnalogPair(client, regType, addr);
        if (!r.ok) continue;

        for (const cand of floatCandidates(r.buf)) {
          for (const tag of analogTags) {
            const score = scoreAnalog(cand.value, tag.key);
            if (score < 0.25) continue;

            const stable = await verifyStable(client, regType, addr, cand.value, false, opts.stableDelayMs);
            hits.push({
              tag: tag.key,
              name: tag.name,
              unit: tag.unit || TAG_PROFILES[tag.key]?.unit || '',
              unitId,
              regType: regType.key,
              register: addr,
              dataType: cand.dataType,
              wordOrder: cand.wordOrder,
              value: cand.value,
              score: score + (stable ? 0.15 : 0),
              stable,
            });
          }
        }
      }
    }
  }

  return hits;
}

async function probeDigital(client, gw, opts) {
  const digitalTags = gw.tags.filter((t) => t.type === 'digital');
  const hits = [];
  const seen = new Set();

  for (let unitId = opts.unitMin; unitId <= opts.unitMax; unitId++) {
    client.setID(unitId);

    for (const regType of REG_TYPES) {
      if (!regType.digital) continue;

      for (let addr = 0; addr < Math.min(opts.maxReg, 64); addr++) {
        const r = await readDigital(client, regType, addr);
        if (!r.ok) continue;

        const stable = await verifyStable(client, regType, addr, r.value, true, opts.stableDelayMs);
        const key = `${unitId}:${regType.key}:${addr}`;
        if (seen.has(key)) continue;
        seen.add(key);

        hits.push({
          unitId,
          regType: regType.key,
          register: addr,
          fn: regType.key === 'coil' ? 'coil' : undefined,
          value: r.value,
          score: 0.5 + (stable ? 0.2 : 0) + (r.value === 0 ? 0.1 : 0),
          stable,
        });
      }
    }
  }

  // Assign discovered addresses to tags in register order (0→first tag, 1→second, …).
  const bestGroup = pickBestDigitalGroup(hits, digitalTags.length);
  return bestGroup.map((h, i) => ({
    ...h,
    tag: digitalTags[i]?.key || `DIG-${i}`,
    name: digitalTags[i]?.name || `Digital ${i}`,
  }));
}

function pickBestDigitalGroup(hits, tagCount) {
  if (!hits.length || !tagCount) return [];

  const byUnitType = {};
  for (const h of hits) {
    const k = `${h.unitId}:${h.regType}`;
    if (!byUnitType[k]) byUnitType[k] = [];
    byUnitType[k].push(h);
  }

  let best = [];
  for (const list of Object.values(byUnitType)) {
    const sorted = [...list].sort((a, b) => a.register - b.register);
    const slice = sorted.slice(0, tagCount);
    const score = slice.reduce((s, h) => s + h.score, 0);
    const bestScore = best.reduce((s, h) => s + h.score, 0);
    if (slice.length > best.length || (slice.length === best.length && score > bestScore)) {
      best = slice;
    }
  }
  return best;
}

function pickBestMapping(hits, tags) {
  // Group by tag, keep top candidates per tag.
  const byTag = {};
  for (const h of hits) {
    if (!byTag[h.tag]) byTag[h.tag] = [];
    byTag[h.tag].push(h);
  }
  for (const k of Object.keys(byTag)) {
    byTag[k].sort((a, b) => b.score - a.score || (b.stable - a.stable));
  }

  const usedRegs = new Set();
  const mapping = [];

  for (const tag of tags) {
    const list = (byTag[tag.key] || []).filter((h) => {
      const key = `${h.unitId}:${h.regType}:${h.register}`;
      return !usedRegs.has(key);
    });
    if (!list.length) continue;
    const best = list[0];
    usedRegs.add(`${best.unitId}:${best.regType}:${best.register}`);
    mapping.push(best);
  }

  return mapping;
}

function printReport(gw, hits, mapping, err) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`${gw.id}  @  ${gw.host}:${gw.port || 502}`);
  console.log('='.repeat(72));

  if (err) {
    console.log(`TCP: FAILED — ${err}`);
    console.log('Skip: check power, WiFi, Modbus TCP enabled on FXA42 web UI.');
    return;
  }

  console.log(`TCP: OK  |  raw hits: ${hits.length}  |  mapped tags: ${mapping.length}/${gw.tags.length}`);

  if (!hits.length) {
    const map = CHANNEL_MAP[gw.id];
    console.log('\nVERDICT: TCP OK but zero Modbus registers responded in scanned range.');
    console.log('Brute-force cannot find mappings that do not exist on the gateway yet.');
    if (map) {
      console.log(`\nConfigure Modbus Server/Slave outputs on ${map.modbusUrl} first.`);
      console.log('Run: node probe.js ' + gw.host + '  for step-by-step register map.');
    } else {
      console.log('Try: node probe.js ' + gw.host);
    }
    console.log('After FXA42 restart: node discover.js ' + gw.host);
    return;
  }

  // Top unassigned candidates
  const top = [...hits].sort((a, b) => b.score - a.score).slice(0, 12);
  console.log('\nTop candidates:');
  console.log('tag      unit  type     reg   decode           value        score stable');
  console.log('-'.repeat(72));
  for (const h of top) {
    const decode = h.dataType ? `${h.dataType} ${h.wordOrder}` : (h.fn === 'coil' ? 'coil' : 'uint16');
    const val = h.unit ? `${h.value.toFixed(2)} ${h.unit}` : String(h.value);
    console.log(
      `${h.tag.padEnd(8)} ${String(h.unitId).padEnd(4)}  ${h.regType.padEnd(8)} ${String(h.register).padEnd(4)}  `
      + `${decode.padEnd(16)} ${val.padEnd(12)} ${h.score.toFixed(2).padStart(5)} ${h.stable ? 'yes' : 'no'}`
    );
  }

  if (!mapping.length) return;

  const bestUnit = mapping[0].unitId;
  const bestType = mapping[0].regType;
  console.log(`\nBest guess: unitId=${bestUnit}, register type=${bestType}`);

  console.log('\nSuggested config.js entries:');
  for (const m of mapping) {
    if (m.dataType) {
      console.log(
        `  { key: '${m.tag}', register: ${m.register}, dataType: '${m.dataType}', `
        + `wordOrder: '${m.wordOrder}' },  // ${m.name}: ${m.value.toFixed(2)} ${m.unit || ''}`
      );
    } else {
      const coil = m.fn === 'coil' ? ", fn: 'coil'" : '';
      console.log(
        `  { key: '${m.tag}', register: ${m.register}${coil} },  // ${m.name}: ${m.value}`
      );
    }
  }
}

async function discoverHost(host, opts) {
  const gw = gatewayForHost(host);
  if (opts.port) gw.port = opts.port;
  const isDigital = opts.digital || gw.tags.every((t) => t.type === 'digital');
  const isAnalog = opts.analog || gw.tags.some((t) => t.type === 'analog');

  let client;
  try {
    client = await connect(host, gw.port || 502, opts.timeout);
  } catch (err) {
    printReport(gw, [], [], err.message);
    return;
  }

  const hits = [];
  if (isAnalog && !opts.digital) hits.push(...(await probeAnalog(client, gw, opts)));
  if (isDigital && !opts.analog) hits.push(...(await probeDigital(client, gw, opts)));

  const mapping = pickBestMapping(hits, gw.tags);
  printReport(gw, hits, mapping, null);
  client.close(() => {});
}

async function runOnce(opts) {
  console.log(`\n[baleen-discover] scanning ${opts.hosts.length} host(s)`);
  console.log(`  registers 0..${opts.maxReg - 1}, unit IDs ${opts.unitMin}-${opts.unitMax}, step ${opts.step}`);
  for (const host of opts.hosts) {
    await discoverHost(host, opts);
  }
  console.log('\nDone. Compare values to FXA42 Grid View, then update config.js and run: node index.js');
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.hosts.length) {
    console.error('usage: node discover.js [host] [--digital|--analog] [--max-reg N] [--units 1-10] [--watch SEC]');
    process.exit(1);
  }

  if (opts.watch > 0) {
    console.log(`[baleen-discover] watch mode: every ${opts.watch}s (Ctrl+C to stop)`);
    for (;;) {
      await runOnce(opts);
      await new Promise((r) => setTimeout(r, opts.watch * 1000));
    }
  } else {
    await runOnce(opts);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
