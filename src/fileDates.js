import { parseLocalDate } from './scheduler.js';

function validDate(year, month, day) {
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return parseLocalDate(`${date}T00:00:00.000`) === null ? null : date;
}

export function extractFilenameDate(filename) {
  const name = String(filename || '');
  const patterns = [
    /(?:^|[^0-9])(\d{4})[-_.](\d{1,2})[-_.](\d{1,2})(?=$|[^0-9])/g,
    /(?:^|[^0-9])(\d{4})(\d{2})(\d{2})(?=$|[^0-9])/g,
  ];

  for (const pattern of patterns) {
    for (const match of name.matchAll(pattern)) {
      const date = validDate(Number(match[1]), Number(match[2]), Number(match[3]));
      if (date) return date;
    }
  }
  return null;
}

export function mostCommonFileDate(files, fallbackDate) {
  const dates = files.flatMap((file) => {
    const filenameDate = extractFilenameDate(file.name);
    if (filenameDate) return [filenameDate, filenameDate];
    return [file.createdAt, file.modifiedAt]
      .map((value) => String(value || '').slice(0, 10))
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)
        && parseLocalDate(`${value}T00:00:00.000`) !== null);
  });

  if (!dates.length) return fallbackDate;
  const counts = new Map();
  for (const date of dates) counts.set(date, (counts.get(date) || 0) + 1);
  const highestCount = Math.max(...counts.values());
  const firstDate = dates.find((date) => counts.get(date) === highestCount);
  return firstDate || fallbackDate;
}
