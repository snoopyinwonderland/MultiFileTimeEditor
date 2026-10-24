import test from 'node:test';
import assert from 'node:assert/strict';
import { gapForBytes, gapForFile } from './src/gapModel.js';
import { buildTimeline, parseLocalDate, shiftSubsequentSlotsForHourChange } from './src/scheduler.js';
import { extractFilenameDate, mostCommonFileDate } from './src/fileDates.js';

const base = parseLocalDate('2025-01-01T00:00:00.000');
const scheduleDate = '2025-01-01';

function timeAt(offsetMs) {
  const date = new Date(base + offsetMs);
  const pad = (number, length = 2) => String(number).padStart(length, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

test('uses the next timestamp strictly beyond the size-based minimum gap', () => {
  const files = [{ path: 'one.ts', name: 'one.ts', size: 1_000_000 }, { path: 'two.ts', name: 'two.ts', size: 1_000_000 }];
  const result = buildTimeline(files, [0, 50, 58, 114, 115, 116, 174].map(timeAt), scheduleDate);
  const minimum = gapForBytes(files[0].size);

  assert.equal(result.preview[0].createdMs, base);
  assert.equal(result.preview[0].modifiedMs, base + 58);
  assert.equal(result.preview[1].createdMs, base + 58);
  assert.equal(result.preview[1].modifiedMs, base + 116);
  assert.ok(result.preview[0].modifiedMs - result.preview[0].createdMs > minimum);
});

test('a manual event becomes an anchor and automatic assignment resumes after it', () => {
  const files = [{ path: 'one.ts', name: 'one.ts', size: 1_000_000 }, { path: 'two.ts', name: 'two.ts', size: 1_000_000 }];
  const result = buildTimeline(files, [0, 100, 400, 500, 550, 557, 558, 615, 616].map(timeAt), scheduleDate, { 'modified:0': timeAt(500) });

  assert.equal(result.preview[0].modifiedMs, base + 500);
  assert.equal(result.preview[0].modifiedManual, true);
  assert.equal(result.preview[1].createdMs, base + 550);
  assert.equal(result.preview[1].modifiedMs, base + 615);
  assert.equal(result.preview[1].modifiedManual, false);
});

test('does not wrap around when the remaining timetable has no valid candidate', () => {
  const files = [{ path: 'one.ts', name: 'one.ts', size: 1_000_000 }];
  const result = buildTimeline(files, [timeAt(0)], scheduleDate);

  assert.equal(result.preview[0].createdMs, base);
  assert.equal(result.preview[0].modifiedMs, null);
  assert.equal(result.stoppedAt, 1);
});

test('rejects a manually entered timestamp that moves backwards', () => {
  const files = [{ path: 'one.ts', name: 'one.ts', size: 1_000_000 }];
  const result = buildTimeline(files, [timeAt(60_000), timeAt(60_100)], scheduleDate, { 'modified:0': timeAt(59_999) });

  assert.deepEqual(result.invalidOrderEvents, [1]);
  assert.equal(result.preview[0].modifiedMs, base + 59_999);
});

test('allows equal timestamps at a manual file boundary and within a file', () => {
  const files = [
    { path: 'one.ts', name: 'one.ts', size: 1_000_000 },
    { path: 'two.ts', name: 'two.ts', size: 1_000_000 },
  ];
  const result = buildTimeline(
    files,
    [timeAt(0), timeAt(58), timeAt(100), timeAt(158), timeAt(220)].map((value) => value),
    scheduleDate,
    { 'modified:0': timeAt(100), 'created:1': timeAt(100), 'modified:1': timeAt(100) },
  );

  assert.equal(result.preview[0].modifiedMs, base + 100);
  assert.equal(result.preview[1].createdMs, base + 100);
  assert.equal(result.preview[1].modifiedMs, base + 100);
  assert.deepEqual(result.invalidOrderEvents, []);
});

test('shifts later timetable slots by the edited slot hour delta', () => {
  const slots = ['07:11:11.111', '07:11:11.777', '08:00:00.001', '', '09:30:00.100'];
  const updated = shiftSubsequentSlotsForHourChange(slots, 0, '08:11:11.111');

  assert.deepEqual(updated, ['08:11:11.111', '08:11:11.777', '09:00:00.001', '', '10:30:00.100']);
  assert.deepEqual(slots, ['07:11:11.111', '07:11:11.777', '08:00:00.001', '', '09:30:00.100']);
});

test('does not wrap later slots across midnight when shifting hours', () => {
  const slots = ['23:10:00.000', '23:45:00.000', '22:30:00.000'];
  const updated = shiftSubsequentSlotsForHourChange(slots, 0, '00:10:00.000');

  assert.deepEqual(updated, ['00:10:00.000', '23:45:00.000', '22:30:00.000']);
});

test('treats midnight-adjacent hour edits as a one-hour shift', () => {
  const slots = ['23:00:00.000', '01:30:00.000', '03:00:00.000'];
  const updated = shiftSubsequentSlotsForHourChange(slots, 0, '00:00:00.000');

  assert.deepEqual(updated, ['00:00:00.000', '02:30:00.000', '04:00:00.000']);
});

test('manually editing a file creation time does not change the previous file modification time', () => {
  const files = [
    { path: 'one.ts', name: 'one.ts', size: 1_000_000 },
    { path: 'two.ts', name: 'two.ts', size: 1_000_000 },
  ];
  const result = buildTimeline(
    files,
    [0, 58, 100, 158, 220].map(timeAt),
    scheduleDate,
    { 'created:1': timeAt(100) },
  );

  assert.equal(result.preview[0].modifiedMs, base + 58);
  assert.equal(result.preview[1].createdMs, base + 100);
  assert.equal(result.preview[1].createdManual, true);
  assert.equal(result.preview[1].modifiedMs, base + 158);
});

test('manually editing a modification time breaks its link to the next file creation time', () => {
  const files = [
    { path: 'one.ts', name: 'one.ts', size: 1_000_000 },
    { path: 'two.ts', name: 'two.ts', size: 1_000_000 },
  ];
  const result = buildTimeline(
    files,
    [0, 58, 100, 158, 220].map(timeAt),
    scheduleDate,
    { 'modified:0': timeAt(58) },
  );

  assert.equal(result.preview[0].modifiedMs, base + 58);
  assert.equal(result.preview[1].createdMs, base + 100);
  assert.equal(result.preview[1].createdManual, false);
});

test('parses millisecond local datetime values and rejects invalid calendar dates', () => {
  assert.equal(parseLocalDate('2025-01-01T00:00:00.007'), base + 7);
  assert.equal(parseLocalDate('2025-02-30T00:00:00.000'), null);
});

test('recognizes compact and separated calendar dates in filenames', () => {
  assert.equal(extractFilenameDate('KBS1_20261019_0600.ts'), '2026-10-19');
  assert.equal(extractFilenameDate('recording-2026.10.19-final.ts'), '2026-10-19');
  assert.equal(extractFilenameDate('recording_2026-10-19.ts'), '2026-10-19');
});

test('ignores invalid filename dates and longer digit strings', () => {
  assert.equal(extractFilenameDate('recording_20260230.ts'), null);
  assert.equal(extractFilenameDate('recording_1202610199.ts'), null);
});

test('uses filename dates instead of differing filesystem dates when choosing the loaded date', () => {
  const files = [
    { name: 'show_20261019_0600.ts', createdAt: '2024-01-01T10:00:00.000', modifiedAt: '2025-02-02T11:00:00.000' },
    { name: 'show_20261019_0700.ts', createdAt: '2023-03-03T10:00:00.000', modifiedAt: '2022-04-04T11:00:00.000' },
    { name: 'untagged.ts', createdAt: '2024-01-01T10:00:00.000', modifiedAt: '2025-02-02T11:00:00.000' },
  ];

  assert.equal(mostCommonFileDate(files, '2026-10-23'), '2026-10-19');
});

test('falls back to file creation/modification dates when filenames have no valid date', () => {
  const files = [
    { name: 'untagged.ts', createdAt: '2025-01-01T10:00:00.000', modifiedAt: '2025-01-01T11:00:00.000' },
    { name: 'also-untagged.ts', createdAt: '2025-01-01T12:00:00.000', modifiedAt: '2024-12-31T11:00:00.000' },
  ];

  assert.equal(mostCommonFileDate(files, '2026-10-23'), '2025-01-01');
});

test('prefers the file original gap unless it exceeds the size average by more than 1.5x', () => {
  const modelGapMs = gapForBytes(1_000_000);
  const observedGap = (modifiedAt) => gapForFile({
    size: 1_000_000,
    createdAt: '2025-01-01T00:00:00.000',
    modifiedAt,
  });

  assert.equal(observedGap('2025-01-01T00:00:00.040').estimatedGapMs, 40);
  assert.equal(observedGap('2025-01-01T00:00:00.090').estimatedGapMs, modelGapMs);
  assert.equal(observedGap('2025-01-01T00:00:00.000').estimatedGapMs, modelGapMs);
});
