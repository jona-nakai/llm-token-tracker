process.env.TZ = 'America/Los_Angeles';

const assert = (await import('node:assert/strict')).default;
const { test } = await import('node:test');
const {
  bucketLabel, fromDateKey, periodBuckets, periodLabel, periodRange, shiftAnchor, toDateKey,
} = await import('../public/lib/periods.js');

const day = (key) => fromDateKey(key);

test('weeks run Monday through Sunday', () => {
  for (const key of ['2026-09-21', '2026-09-25', '2026-09-27']) {
    const { start, end } = periodRange('week', day(key));
    assert.equal(toDateKey(start), '2026-09-21');
    assert.equal(toDateKey(end), '2026-09-28');
  }
  assert.equal(toDateKey(periodRange('week', day('2026-09-28')).start), '2026-09-28');
});

test('day and month ranges are half-open calendar ranges', () => {
  const dayRange = periodRange('day', new Date(2026, 8, 25, 23, 59));
  assert.equal(toDateKey(dayRange.start), '2026-09-25');
  assert.equal(toDateKey(dayRange.end), '2026-09-26');
  const month = periodRange('month', day('2026-02-14'));
  assert.equal(toDateKey(month.start), '2026-02-01');
  assert.equal(toDateKey(month.end), '2026-03-01');
  assert.deepEqual(periodRange('all', new Date()), { start: null, end: null });
});

test('shifting moves one period and month steps never skip a month', () => {
  assert.equal(toDateKey(shiftAnchor('day', day('2026-03-01'), -1)), '2026-02-28');
  assert.equal(toDateKey(shiftAnchor('week', day('2026-09-25'), 1)), '2026-10-02');
  assert.equal(toDateKey(shiftAnchor('month', day('2026-01-31'), 1)), '2026-02-01');
  assert.equal(toDateKey(shiftAnchor('month', day('2026-01-15'), -1)), '2025-12-01');
});

test('buckets: hours, days, and months', () => {
  const now = new Date(2026, 8, 25, 12);
  assert.equal(periodBuckets('day', periodRange('day', now), null, now).length, 24);
  assert.equal(periodBuckets('week', periodRange('week', now), null, now).length, 7);
  assert.equal(periodBuckets('month', periodRange('month', now), null, now).length, 30);
  const months = periodBuckets('all', periodRange('all', now), new Date(2025, 8, 18), now);
  assert.equal(months.length, 13);
  assert.equal(toDateKey(months[0].start), '2025-09-01');
  assert.equal(toDateKey(months.at(-1).end), '2026-10-01');
});

test('buckets survive DST transitions', () => {
  const springForward = day('2026-03-08');
  const spring = periodBuckets('day', periodRange('day', springForward), null, springForward);
  assert.equal(spring.length, 23);
  assert.equal(spring.at(-1).end.getTime(), periodRange('day', springForward).end.getTime());

  const fallBack = day('2026-11-01');
  const fall = periodBuckets('day', periodRange('day', fallBack), null, fallBack);
  assert.equal(fall.length, 24);
  const hours = (fall.at(-1).end - fall[0].start) / 3600_000;
  assert.equal(hours, 25);
});

test('labels', () => {
  assert.equal(periodLabel('day', periodRange('day', day('2026-09-25'))), 'Fri, Sep 25, 2026');
  assert.equal(periodLabel('week', periodRange('week', day('2026-09-25'))), 'Sep 21 – 27, 2026');
  assert.equal(periodLabel('week', periodRange('week', day('2026-09-30'))), 'Sep 28 – Oct 4, 2026');
  assert.equal(periodLabel('week', periodRange('week', day('2026-12-31'))), 'Dec 28, 2026 – Jan 3, 2027');
  assert.equal(periodLabel('month', periodRange('month', day('2026-09-25'))), 'September 2026');
  assert.equal(periodLabel('all', periodRange('all', new Date()), day('2025-09-18')), 'Since Sep 18, 2025');
  assert.equal(bucketLabel('day', new Date(2026, 8, 25, 0)), '12a');
  assert.equal(bucketLabel('day', new Date(2026, 8, 25, 13)), '1p');
});

test('date keys round-trip and reject invalid dates', () => {
  assert.equal(toDateKey(day('2026-09-25')), '2026-09-25');
  assert.equal(fromDateKey('2026-02-30'), null);
  assert.equal(fromDateKey('yesterday'), null);
});
