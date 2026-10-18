export function chunkSymbols(symbols, size = 25) {
  if (!Array.isArray(symbols)) throw new TypeError("symbols must be an array");
  if (!Number.isInteger(size) || size < 1)
    throw new RangeError("batch size must be a positive integer");
  const batches = [];
  for (let i = 0; i < symbols.length; i += size)
    batches.push(symbols.slice(i, i + size));
  return batches;
}
