// Robust size-based estimates derived from 8,587 year-2025 .ts files in
// Source set: 2025-dated video files gathered from Edited folders.
// The samples were sorted by size into equal-count bands. Within each band,
// the upper tail was clipped at median + 4.4478 * MAD before averaging.
const MODEL = [
  { maxBytes: 16_428_380, meanMs: 56.6 },
  { maxBytes: 21_702_344, meanMs: 97.3 },
  { maxBytes: 26_619_296, meanMs: 115.2 },
  { maxBytes: 39_053_428, meanMs: 153.6 },
  { maxBytes: 47_709_888, meanMs: 189.1 },
  { maxBytes: 62_918_148, meanMs: 227.2 },
  { maxBytes: 99_575_892, meanMs: 359.9 },
  { maxBytes: 157_531_028, meanMs: 593.4 },
  { maxBytes: 337_472_408, meanMs: 77_448.5 },
  { maxBytes: Number.POSITIVE_INFINITY, meanMs: 216_393.7 },
];

export function gapForBytes(bytes) {
  const band = MODEL.find((entry) => bytes <= entry.maxBytes) || MODEL[MODEL.length - 1];
  return Math.ceil(band.meanMs);
}

export function gapForFile(file) {
  const modelGapMs = gapForBytes(file.size);
  const createdMs = Date.parse(file.createdAt);
  const modifiedMs = Date.parse(file.modifiedAt);
  const observedGapMs = Number.isFinite(createdMs) && Number.isFinite(modifiedMs)
    ? modifiedMs - createdMs
    : null;
  const hasUsableObservedGap = Number.isFinite(observedGapMs) && observedGapMs > 0;
  const useObservedGap = hasUsableObservedGap && observedGapMs <= modelGapMs * 1.5;

  return {
    modelGapMs,
    actualGapMs: hasUsableObservedGap ? observedGapMs : null,
    estimatedGapMs: useObservedGap ? Math.ceil(observedGapMs) : modelGapMs,
    gapSource: useObservedGap ? 'actual' : 'model',
  };
}
