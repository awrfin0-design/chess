// Time controls and rating categories.

export const CATEGORIES = ['bullet', 'blitz', 'rapid', 'classical'];

// Allowed base times in minutes and increments in seconds.
export const MINUTE_OPTIONS = [
  0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 35, 40, 45, 60, 75, 90, 120, 150, 180,
];
export const INCREMENT_OPTIONS = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30, 40, 45, 60, 90, 120, 180,
];

/** Classify by estimated game duration: base + 40 * increment (seconds). */
export function categoryOf(minutes, increment) {
  const estimate = minutes * 60 + 40 * increment;
  if (estimate < 180) return 'bullet';
  if (estimate < 480) return 'blitz';
  if (estimate < 1500) return 'rapid';
  return 'classical';
}

/** Validate untrusted input. Returns {minutes, increment} or null. */
export function parseTimeControl(input) {
  if (!input || typeof input !== 'object') return null;
  const minutes = Number(input.minutes);
  const increment = Number(input.increment);
  if (!MINUTE_OPTIONS.includes(minutes) || !INCREMENT_OPTIONS.includes(increment)) return null;
  return { minutes, increment };
}

export function formatMinutes(minutes) {
  if (minutes === 0.25) return '¼';
  if (minutes === 0.5) return '½';
  if (minutes === 0.75) return '¾';
  if (minutes === 1.5) return '1½';
  return String(minutes);
}

export function formatTimeControl(minutes, increment) {
  return `${formatMinutes(minutes)}+${increment}`;
}
