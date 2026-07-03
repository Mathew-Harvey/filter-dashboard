'use strict';

// Returns 'ok' | 'warn' | 'alarm' | 'stale'.
function evaluate(tag, reading) {
  if (!reading || reading.quality !== 'good' || reading.value === null) return 'stale';

  if (tag.type === 'digital') {
    // value 1 = fault active (after any inversion applied at read time)
    return reading.value ? 'alarm' : 'ok';
  }

  const v = reading.value;
  const a = tag.alarm || {};
  if ((a.high != null && v >= a.high) || (a.low != null && v <= a.low)) return 'alarm';
  if ((a.warnHigh != null && v >= a.warnHigh) || (a.warnLow != null && v <= a.warnLow)) return 'warn';
  return 'ok';
}

function message(tag, reading, status) {
  if (status === 'stale') return `${tag.name}: no data (comms/loop fault)`;
  if (tag.type === 'digital') return `${tag.name}: ${status === 'alarm' ? 'FAULT' : 'clear'}`;
  const v = reading.value;
  const unit = tag.unit || '';
  return `${tag.name}: ${v.toFixed(2)} ${unit} (${status})`;
}

module.exports = { evaluate, message };
