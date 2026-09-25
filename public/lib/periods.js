// Calendar periods in local time, shared by the server and the browser.
// Weeks run Monday through Sunday. Ranges are half-open: [start, end).

export const PERIODS = ['day', 'week', 'month', 'all'];

const pad = (n) => String(n).padStart(2, '0');

export function toDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function fromDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return toDateKey(date) === key ? date : null;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Calendar arithmetic through the Date constructor stays correct across DST.
function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function periodRange(period, anchor) {
  const day = startOfDay(anchor);
  switch (period) {
    case 'day':
      return { start: day, end: addDays(day, 1) };
    case 'week': {
      const start = addDays(day, -((day.getDay() + 6) % 7));
      return { start, end: addDays(start, 7) };
    }
    case 'month':
      return {
        start: new Date(day.getFullYear(), day.getMonth(), 1),
        end: new Date(day.getFullYear(), day.getMonth() + 1, 1),
      };
    case 'all':
      return { start: null, end: null };
    default:
      throw new Error(`Unknown period: ${period}`);
  }
}

// Moves the anchor by `step` periods. Month steps land on the 1st so that
// stepping from Jan 31 never skips February.
export function shiftAnchor(period, anchor, step) {
  switch (period) {
    case 'day':
      return addDays(anchor, step);
    case 'week':
      return addDays(anchor, 7 * step);
    case 'month':
      return new Date(anchor.getFullYear(), anchor.getMonth() + step, 1);
    default:
      return startOfDay(anchor);
  }
}

// Chart buckets for a period: hours of a day, days of a week or month, and
// months for all time (from the first recorded usage through `now`).
export function periodBuckets(period, range, firstUsage, now) {
  const starts = [];
  if (period === 'day') {
    const { start } = range;
    for (let hour = 0; hour < 24; hour += 1) {
      const bucket = new Date(start.getFullYear(), start.getMonth(), start.getDate(), hour);
      // A spring-forward day has a missing hour; skip the duplicate.
      if (!starts.length || bucket > starts.at(-1)) starts.push(bucket);
    }
  } else if (period === 'week' || period === 'month') {
    for (let day = range.start; day < range.end; day = addDays(day, 1)) starts.push(day);
  } else {
    const first = firstUsage ?? now;
    let month = new Date(first.getFullYear(), first.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 1);
    for (; month <= last; month = new Date(month.getFullYear(), month.getMonth() + 1, 1)) {
      starts.push(month);
    }
  }
  const end = range.end ?? new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? end }));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function periodLabel(period, range, firstUsage) {
  const { start } = range;
  switch (period) {
    case 'day':
      return `${WEEKDAYS[start.getDay()]}, ${MONTHS[start.getMonth()]} ${start.getDate()}, ${start.getFullYear()}`;
    case 'week': {
      const last = addDays(range.end, -1);
      const tail = last.getMonth() === start.getMonth()
        ? `${last.getDate()}`
        : `${MONTHS[last.getMonth()]} ${last.getDate()}`;
      const year = last.getFullYear() === start.getFullYear() ? '' : `, ${start.getFullYear()}`;
      return `${MONTHS[start.getMonth()]} ${start.getDate()}${year} – ${tail}, ${last.getFullYear()}`;
    }
    case 'month':
      return `${MONTHS_LONG[start.getMonth()]} ${start.getFullYear()}`;
    default:
      return firstUsage
        ? `Since ${MONTHS[firstUsage.getMonth()]} ${firstUsage.getDate()}, ${firstUsage.getFullYear()}`
        : 'All time';
  }
}

export function bucketLabel(period, start) {
  if (period === 'day') {
    const hour = start.getHours();
    return `${hour % 12 || 12}${hour < 12 ? 'a' : 'p'}`;
  }
  if (period === 'week') return `${WEEKDAYS[start.getDay()]} ${start.getDate()}`;
  if (period === 'month') return String(start.getDate());
  return `${MONTHS[start.getMonth()]} ${String(start.getFullYear()).slice(2)}`;
}
