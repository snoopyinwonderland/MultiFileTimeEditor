import { gapForFile } from './gapModel.js';

export function parseLocalDate(value) {
  if (!value) return null;
  const [datePart, timePart] = value.split('T');
  if (!timePart) return null;
  const [year, month, day] = datePart.split('-').map(Number);
  const [clock, fraction = '0'] = timePart.split('.');
  const [hour, minute, second = 0] = clock.split(':').map(Number);
  const millisecond = Number(fraction.padEnd(3, '0').slice(0, 3));
  const date = new Date(year, month - 1, day, hour, minute, second, millisecond);
  if (!Number.isFinite(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second
    || date.getMilliseconds() !== millisecond) return null;
  return date.getTime();
}

function normalizedTime(value) {
  const text = String(value || '');
  const time = text.includes('T') ? text.split('T')[1] : text;
  const match = time.match(/^(\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!match) return '';
  return `${match[1]}:${match[2] || '00'}.${(match[3] || '0').padEnd(3, '0')}`;
}

export function shiftSubsequentSlotsForHourChange(slots, editedIndex, nextValue) {
  const nextTime = normalizedTime(nextValue);
  const previousTime = normalizedTime(slots[editedIndex]);
  if (!nextTime) return slots;

  let hourDelta = previousTime
    ? Number(nextTime.slice(0, 2)) - Number(previousTime.slice(0, 2))
    : 0;
  // Interpret 23 -> 00 and 00 -> 23 as a one-hour adjustment, not a 23-hour jump.
  if (hourDelta > 12) hourDelta -= 24;
  if (hourDelta < -12) hourDelta += 24;
  const updated = [...slots];
  updated[editedIndex] = nextTime;
  if (hourDelta === 0) return updated;

  const dayMilliseconds = 24 * 60 * 60 * 1000;
  for (let index = editedIndex + 1; index < updated.length; index += 1) {
    const time = normalizedTime(updated[index]);
    if (!time) continue;
    const [clock, fraction] = time.split('.');
    const [hour, minute, second] = clock.split(':').map(Number);
    const milliseconds = ((hour * 60 + minute) * 60 + second) * 1000 + Number(fraction);
    const shifted = milliseconds + hourDelta * 60 * 60 * 1000;
    // Schedule slots have no date component, so wrapping across midnight would silently
    // flip an afternoon slot into the morning. Leave this and later slots alone instead.
    if (shifted < 0 || shifted >= dayMilliseconds) break;
    const shiftedHour = Math.floor(shifted / 3_600_000);
    const shiftedMinute = Math.floor((shifted % 3_600_000) / 60_000);
    const shiftedSecond = Math.floor((shifted % 60_000) / 1000);
    const shiftedMillisecond = shifted % 1000;
    const pad = (value, length = 2) => String(value).padStart(length, '0');
    updated[index] = `${pad(shiftedHour)}:${pad(shiftedMinute)}:${pad(shiftedSecond)}.${pad(shiftedMillisecond, 3)}`;
  }
  return updated;
}

function millisecondsForTime(date, value) {
  const time = normalizedTime(value);
  return date && time ? parseLocalDate(`${date}T${time}`) : null;
}

export function buildTimeline(files, scheduleSlots, scheduleDate, overrides = {}) {
  const candidates = scheduleSlots
    .map((value, slotIndex) => ({ value, milliseconds: millisecondsForTime(scheduleDate, value), slotIndex }))
    .filter((slot) => Number.isFinite(slot.milliseconds));
  const events = [];
  let candidateIndex = 0;
  let previousModifiedMs = null;
  let previousModifiedManual = false;
  let stoppedAt = -1;
  const invalidOrderEvents = [];

  const consumeThrough = (milliseconds) => {
    while (candidateIndex < candidates.length && candidates[candidateIndex].milliseconds <= milliseconds) {
      candidateIndex += 1;
    }
  };
  const takeNextAfter = (minimumMs = null) => {
    if (minimumMs !== null) consumeThrough(minimumMs);
    const candidate = candidates[candidateIndex];
    if (!candidate) return null;
    candidateIndex += 1;
    return candidate;
  };
  const preview = [];

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    const createdOverride = overrides[`created:${fileIndex}`];
    const modifiedOverride = overrides[`modified:${fileIndex}`];
    const createdManual = createdOverride !== undefined;
    const modifiedManual = modifiedOverride !== undefined;
    const createdCandidate = createdManual
      ? null
      : fileIndex === 0 || previousModifiedManual
        ? takeNextAfter(fileIndex === 0 ? null : previousModifiedMs)
        : null;
    const createdMs = createdManual
      ? millisecondsForTime(scheduleDate, createdOverride)
      : fileIndex === 0 || previousModifiedManual
        ? createdCandidate?.milliseconds ?? null
        : previousModifiedMs;
    const createdSourceSlot = createdCandidate?.slotIndex ?? null;

    if (!Number.isFinite(createdMs)) {
      stoppedAt = fileIndex * 2;
      preview.push({
        ...file,
        createdMs: null,
        modifiedMs: null,
        createdManual: false,
        modifiedManual: false,
        ...gapForFile(file),
        eventIndexForCreated: fileIndex,
        eventIndexForModified: fileIndex,
      });
      events.push({ eventIndex: fileIndex * 2, milliseconds: null, manual: false, sourceSlot: null });
      previousModifiedMs = null;
      previousModifiedManual = false;
      continue;
    }

    if (createdManual) consumeThrough(createdMs);
    if (previousModifiedMs !== null && (createdManual || previousModifiedManual) && createdMs < previousModifiedMs) {
      invalidOrderEvents.push(fileIndex * 2);
    }

    const modifiedCandidate = modifiedManual
      ? null
      : takeNextAfter(createdMs + gapForFile(file).estimatedGapMs);
    const modifiedMs = modifiedManual
      ? millisecondsForTime(scheduleDate, modifiedOverride)
      : modifiedCandidate?.milliseconds ?? null;
    const modifiedSourceSlot = modifiedCandidate?.slotIndex ?? null;
    if (modifiedManual && Number.isFinite(modifiedMs)) consumeThrough(modifiedMs);

    if (!Number.isFinite(modifiedMs)) {
      stoppedAt = fileIndex * 2 + 1;
      if (Number.isFinite(createdMs)) {
        preview.push({
          ...file,
          createdMs,
          modifiedMs: null,
          createdManual,
          modifiedManual: false,
          ...gapForFile(file),
          eventIndexForCreated: fileIndex,
          eventIndexForModified: fileIndex,
        });
      }
      events.push({ eventIndex: fileIndex * 2, milliseconds: createdMs, manual: createdManual, sourceSlot: createdSourceSlot });
      events.push({ eventIndex: fileIndex * 2 + 1, milliseconds: null, manual: false, sourceSlot: null });
      previousModifiedMs = null;
      previousModifiedManual = false;
      continue;
    }

    if (modifiedMs < createdMs) invalidOrderEvents.push(fileIndex * 2 + 1);
    const filePreview = {
      ...file,
      createdMs,
      modifiedMs,
      createdManual,
      modifiedManual,
      ...gapForFile(file),
      eventIndexForCreated: fileIndex,
      eventIndexForModified: fileIndex,
    };
    preview.push(filePreview);
    events.push({ eventIndex: fileIndex * 2, milliseconds: createdMs, manual: createdManual, sourceSlot: createdSourceSlot });
    events.push({ eventIndex: fileIndex * 2 + 1, milliseconds: modifiedMs, manual: modifiedManual, sourceSlot: modifiedSourceSlot });
    previousModifiedMs = modifiedMs;
    previousModifiedManual = modifiedManual;
  }

  return { preview, events, candidatesCount: candidates.length, stoppedAt, invalidOrderEvents };
}
