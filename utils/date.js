// Nigerian calendar date (YYYY-MM-DD). Due dates are compared against this,
// not UTC, so a series does not flip to "due" at 1am Lagos time.
export const lagosToday = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });