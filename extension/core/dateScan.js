const discordEpoch = 1420070400000n;
const idSpace = 1n << 64n;

function dateBoundary(milliseconds) {
  const boundary = (BigInt(milliseconds) - discordEpoch) << 22n;
  return boundary < 0n ? 0n : boundary > idSpace ? idSpace : boundary;
}

export function dateScanRanges(filters) {
  let ranges = [[0n, idSpace]];
  if (filters.dateEnabled) {
    const start = dateBoundary(filters.startTime);
    const end = dateBoundary(filters.endTime);
    ranges = filters.dateMode === "before" ? [[0n, start]] : filters.dateMode === "after" ? [[end, idSpace]] :
      filters.dateMode === "during" ? [[start, end]] : [[end, idSpace], [0n, start]];
  }
  return Object.freeze(ranges.filter(([lower, upper]) => lower < upper).map(([lower, upper]) =>
    Object.freeze({ lowerId: lower ? String(lower) : "", before: upper < idSpace ? String(upper) : "" })));
}
