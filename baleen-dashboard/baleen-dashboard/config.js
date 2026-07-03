// =============================================================================
// Baleen Filter Skid (F12159) - Supervisor Dashboard configuration
// =============================================================================
// This is the ONLY file you should need to edit for the site.
// Fill in the register numbers after you have mapped them on each FXA42's
// Modbus TCP server page and confirmed them with scan.js.
//
// Two scaling philosophies (pick one per tag):
//   1. Scale on the GATEWAY (recommended): set the FXA42 analog input Scaling to
//      "Range" with the instrument's engineering min/max, map that value to the
//      Modbus register as a FLOAT32, and leave `rescale` undefined here. The
//      gateway then serves engineering units directly.
//   2. Scale HERE: leave the gateway serving raw 4-20 mA (or raw counts) and set
//      `rescale: { inMin, inMax, outMin, outMax }` to do the linear map in Node.
//
// wordOrder only matters for 32-bit types. If a value reads as garbage, try the
// other orders. scan.js prints all four interpretations to help you pick.
//   ABCD = big-endian            DCBA = little-endian
//   CDAB = big-endian word-swap  BADC = little-endian byte-swap
// =============================================================================

module.exports = {
  server: {
    port: 8080,
  },

  db: {
    file: './data/baleen.db',
    retentionDays: 365, // readings older than this are pruned daily
  },

  pollIntervalMs: 1000, // how often to poll every tag
  modbusTimeoutMs: 1500, // per-read timeout before a tag is marked stale

  gateways: [
    {
      id: 'FXA42-1',
      host: '192.168.1.2',
      port: 502,
      unitId: 1, // Modbus unit/slave ID - confirm on the gateway's Modbus page
      tags: [
        {
          key: 'FLM-W',
          name: 'Water flow rate',
          unit: 'L/min',
          type: 'analog',
          register: 0,
          dataType: 'FLOAT32',
          wordOrder: 'ABCD',
          factor: 1000 / 60, // gateway serves m³/h → convert to L/min
          abs: true, // show magnitude only (zero-flow magmeter offset)
          decimals: 3,
          alarm: { warnHigh: 2833, high: 3000, warnLow: null, low: null }, // 170/180 m³/h
        },
        {
          key: 'TUR',
          name: 'Turbidity',
          unit: 'NTU',
          type: 'analog',
          register: 2,
          dataType: 'FLOAT32',
          wordOrder: 'ABCD',
          decimals: 3,
          alarm: { warnHigh: null, high: null, warnLow: null, low: null },
        },
        {
          key: 'BFP',
          name: 'Bag filter pressure',
          unit: 'bar',
          type: 'analog',
          register: 4,
          dataType: 'FLOAT32',
          wordOrder: 'ABCD',
          decimals: 3,
          alarm: { warnHigh: null, high: null, warnLow: null, low: null },
        },
        {
          key: 'ORP',
          name: 'Redox potential',
          unit: 'mV',
          type: 'analog',
          register: 6,
          dataType: 'FLOAT32',
          wordOrder: 'ABCD',
          decimals: 3,
          alarm: { warnHigh: null, high: null, warnLow: null, low: null },
          // NOTE: known loop fault (22.47 mA out of range) as of 16 May 2026 -
          // expect this to read faulty until the electrician clears it.
        },
      ],
    },

    {
      id: 'FXA42-2',
      host: '192.168.1.3',
      port: 502,
      unitId: 1,
      tags: [
        // Digital fault signals from the main PLC via R20-R23.
        // Polarity (energised = fault vs energised = OK) is TBC on site by
        // inducing a known fault - flip `invert` once confirmed.
        // If the FXA42 maps these as COILS rather than holding registers,
        // set `fn: 'coil'` on the tag.
        { key: 'COM-F', name: 'Compressor fault', type: 'digital', register: 0, fn: 'coil', invert: false },
        { key: 'BAL-F', name: 'Baleen filter fault', type: 'digital', register: 1, fn: 'coil', invert: false },
        { key: 'UVM-F', name: 'UV module fault', type: 'digital', register: 2, fn: 'coil', invert: false },
        { key: 'PLN-F', name: 'General plant fault', type: 'digital', register: 3, fn: 'coil', invert: false },
      ],
    },

    {
      id: 'FXA42-3',
      host: '192.168.1.4',
      port: 502,
      unitId: 1,
      // NOTE: this gateway was unpowered on 16 May 2026 (loose 24 V terminal).
      // These tags will read stale until it is back online.
      tags: [
        {
          key: 'UVI', name: 'UV intensity', unit: '%', type: 'analog',
          register: 0, dataType: 'FLOAT32', wordOrder: 'ABCD',
          alarm: { warnHigh: null, high: null, warnLow: 70, low: 50 },
        },
        {
          key: 'BOT-L', name: 'Bow tank level', unit: '%', type: 'analog',
          register: 2, dataType: 'FLOAT32', wordOrder: 'ABCD',
          alarm: { warnHigh: 90, high: 95, warnLow: 10, low: 5 },
        },
        {
          key: 'C2T-L', name: 'C20 tank level', unit: '%', type: 'analog',
          register: 4, dataType: 'FLOAT32', wordOrder: 'ABCD',
          alarm: { warnHigh: 90, high: 95, warnLow: 10, low: 5 },
        },
        {
          key: 'FLM-A', name: 'Compressed air flow', unit: 'm³/h', type: 'analog',
          register: 6, dataType: 'FLOAT32', wordOrder: 'ABCD',
          alarm: { warnHigh: null, high: null, warnLow: null, low: null },
        },
      ],
    },
  ],
};
