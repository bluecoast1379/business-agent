export function normalizeSchedule(schedule = {}) {
  const value = { ...schedule };
  if (value.hour !== undefined && value.minute === undefined) value.minute = 0;
  for (const [field, min, max] of [['minute', 0, 59], ['hour', 0, 23], ['dayOfWeek', 0, 6], ['dayOfMonth', 1, 31]]) {
    if (value[field] !== undefined && (!Number.isInteger(value[field]) || value[field] < min || value[field] > max)) {
      throw new Error(`[scheduler] ${field} must be an integer ${min}..${max}`);
    }
  }
  return value;
}

export function matchesSchedule(schedule, date) {
  if (schedule.minute !== undefined && schedule.minute !== date.getMinutes()) return false;
  if (schedule.hour !== undefined && schedule.hour !== date.getHours()) return false;
  if (schedule.dayOfWeek !== undefined && schedule.dayOfWeek !== date.getDay()) return false;
  if (schedule.dayOfMonth !== undefined && schedule.dayOfMonth !== date.getDate()) return false;
  return true;
}

export function assertScheduler(scheduler) {
  for (const method of ['registerJob', 'runNow', 'listJobs', 'tick', 'start', 'stop']) {
    if (typeof scheduler?.[method] !== 'function') throw new Error(`[scheduler] adapter is missing ${method}()`);
  }
  return scheduler;
}
