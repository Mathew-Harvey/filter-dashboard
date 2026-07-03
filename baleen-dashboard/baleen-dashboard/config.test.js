// Test config: points the three "gateways" at local mock slaves (mock-slave.js).
module.exports = {
  server: { port: 8080 },
  db: { file: './data/test.db', retentionDays: 365 },
  pollIntervalMs: 2000,
  modbusTimeoutMs: 2000,
  gateways: [
    {
      id: 'FXA42-1', host: '127.0.0.1', port: 5021, unitId: 1,
      tags: [
        { key: 'FLM-W', name: 'Water flow rate', unit: 'm³/h', type: 'analog', register: 0, dataType: 'FLOAT32', wordOrder: 'ABCD', alarm: { warnHigh: 140, high: 148, warnLow: null, low: null } },
        { key: 'TUR', name: 'Turbidity', unit: 'NTU', type: 'analog', register: 2, dataType: 'FLOAT32', wordOrder: 'ABCD', alarm: { warnHigh: 3.5, high: 4, warnLow: null, low: null } },
        { key: 'BFP', name: 'Bag filter pressure', unit: 'bar', type: 'analog', register: 4, dataType: 'FLOAT32', wordOrder: 'ABCD', alarm: { warnHigh: null, high: null, warnLow: null, low: null } },
        { key: 'ORP', name: 'Redox potential', unit: 'mV', type: 'analog', register: 6, dataType: 'FLOAT32', wordOrder: 'ABCD', alarm: { warnHigh: null, high: null, warnLow: null, low: null } },
      ],
    },
    {
      id: 'FXA42-2', host: '127.0.0.1', port: 5022, unitId: 1,
      tags: [
        { key: 'COM-F', name: 'Compressor fault', type: 'digital', register: 0, invert: false },
        { key: 'BAL-F', name: 'Baleen filter fault', type: 'digital', register: 1, invert: false },
        { key: 'UVM-F', name: 'UV module fault', type: 'digital', register: 2, invert: false },
        { key: 'PLN-F', name: 'General plant fault', type: 'digital', register: 3, invert: false },
      ],
    },
    {
      id: 'FXA42-3', host: '127.0.0.1', port: 5023, unitId: 1,
      tags: [
        { key: 'UVI', name: 'UV intensity', unit: '%', type: 'analog', register: 0, dataType: 'FLOAT32', wordOrder: 'ABCD', alarm: { warnHigh: null, high: null, warnLow: 70, low: 50 } },
        { key: 'BOT-L', name: 'Bow tank level', unit: '%', type: 'analog', register: 2, dataType: 'FLOAT32', wordOrder: 'ABCD', alarm: { warnHigh: 90, high: 95, warnLow: 10, low: 5 } },
        { key: 'C2T-L', name: 'C20 tank level', unit: '%', type: 'analog', register: 4, dataType: 'FLOAT32', wordOrder: 'ABCD', alarm: { warnHigh: 90, high: 95, warnLow: 10, low: 5 } },
        { key: 'FLM-A', name: 'Compressed air flow', unit: 'm³/h', type: 'analog', register: 6, dataType: 'FLOAT32', wordOrder: 'ABCD', alarm: { warnHigh: null, high: null, warnLow: null, low: null } },
      ],
    },
  ],
};
