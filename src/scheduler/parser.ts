import { Schedule, RecurrencePattern } from './types';

export interface ParsedSchedule {
  schedule: Schedule;
  isValid: boolean;
  error?: string;
}

/**
 * Parses simple schedule strings into full Schedule objects
 *
 * Supported formats:
 * - 'daily@07:00' → daily at 7 AM
 * - 'weekly@monday@09:00' → weekly on Monday at 9 AM
 * - 'monthly@1@10:00' → monthly on 1st day at 10 AM
 * - 'hourly' → every hour
 * - '@15:30' → once today at 3:30 PM
 * - 'once@2024-12-25@10:00' → once on specific date
 */
export function parseScheduleString(scheduleStr: string, timezone: string = 'UTC'): ParsedSchedule {
  try {
    // Check for empty or whitespace-only input first
    if (!scheduleStr || scheduleStr.trim() === '') {
      return {
        schedule: {} as Schedule,
        isValid: false,
        error: 'Empty schedule string',
      };
    }

    const parts = scheduleStr.trim().toLowerCase().split('@');

    if (parts.length === 0) {
      return {
        schedule: {} as Schedule,
        isValid: false,
        error: 'Empty schedule string',
      };
    }

    const pattern = parts[0];

    // Handle different patterns
    switch (pattern) {
      case 'hourly':
        return parseHourly(timezone);

      case 'daily':
        if (parts.length < 2) {
          return {
            schedule: {} as Schedule,
            isValid: false,
            error: 'Daily schedule requires time (e.g., daily@07:00)',
          };
        }
        return parseDaily(parts[1], timezone);

      case 'weekly':
        if (parts.length < 3) {
          return {
            schedule: {} as Schedule,
            isValid: false,
            error: 'Weekly schedule requires day and time (e.g., weekly@monday@09:00)',
          };
        }
        return parseWeekly(parts[1], parts[2], timezone);

      case 'monthly':
        if (parts.length < 3) {
          return {
            schedule: {} as Schedule,
            isValid: false,
            error: 'Monthly schedule requires day and time (e.g., monthly@1@10:00)',
          };
        }
        return parseMonthly(parts[1], parts[2], timezone);

      case 'once':
        if (parts.length < 3) {
          return {
            schedule: {} as Schedule,
            isValid: false,
            error: 'Once schedule requires date and time (e.g., once@2024-12-25@10:00)',
          };
        }
        return parseOnce(parts[1], parts[2], timezone);

      case '':
        // Handle '@15:30' format (once today)
        if (parts.length >= 2) {
          const isoString = new Date().toISOString();
          const dateParts = isoString.split('T');
          const today = dateParts[0] ?? isoString.slice(0, 10); // Fallback to slice if split fails
          return parseOnce(today, parts[1], timezone);
        }
        return {
          schedule: {} as Schedule,
          isValid: false,
          error: 'Invalid schedule format',
        };

      default:
        return {
          schedule: {} as Schedule,
          isValid: false,
          error: `Unknown schedule pattern: ${pattern}`,
        };
    }
  } catch (error) {
    return {
      schedule: {} as Schedule,
      isValid: false,
      error: `Parse error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

function parseHourly(timezone: string): ParsedSchedule {
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setHours(now.getHours() + 1, 0, 0, 0);

  return {
    schedule: {
      type: 'recurring',
      executeAt: nextHour,
      recurrence: {
        pattern: 'custom' as RecurrencePattern,
        interval: 1,
        customCron: '0 * * * *', // Every hour
      },
      timezone,
    },
    isValid: true,
  };
}

function parseDaily(timeStr: string, timezone: string): ParsedSchedule {
  const executeAt = parseTime(timeStr, timezone);
  if (!executeAt.isValid || !executeAt.time) {
    return {
      schedule: {} as Schedule,
      isValid: false,
      error: executeAt.error ?? 'Failed to parse time',
    };
  }

  return {
    schedule: {
      type: 'recurring',
      executeAt: executeAt.time,
      recurrence: {
        pattern: 'daily' as RecurrencePattern,
        interval: 1,
      },
      timezone,
    },
    isValid: true,
  };
}

function parseWeekly(dayStr: string, timeStr: string, timezone: string): ParsedSchedule {
  const dayOfWeek = parseDayOfWeek(dayStr);
  if (dayOfWeek === -1) {
    return {
      schedule: {} as Schedule,
      isValid: false,
      error: `Invalid day of week: ${dayStr}`,
    };
  }

  const executeAt = parseTime(timeStr, timezone);
  if (!executeAt.isValid || !executeAt.time) {
    return {
      schedule: {} as Schedule,
      isValid: false,
      error: executeAt.error ?? 'Failed to parse time',
    };
  }

  // Find next occurrence of this day
  const nextDate = getNextWeekday(dayOfWeek, executeAt.time);

  return {
    schedule: {
      type: 'recurring',
      executeAt: nextDate,
      recurrence: {
        pattern: 'weekly' as RecurrencePattern,
        interval: 1,
        daysOfWeek: [dayOfWeek],
      },
      timezone,
    },
    isValid: true,
  };
}

function parseMonthly(dayStr: string, timeStr: string, timezone: string): ParsedSchedule {
  const dayOfMonth = parseInt(dayStr);
  if (isNaN(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
    return {
      schedule: {} as Schedule,
      isValid: false,
      error: `Invalid day of month: ${dayStr}`,
    };
  }

  const executeAt = parseTime(timeStr, timezone);
  if (!executeAt.isValid || !executeAt.time) {
    return {
      schedule: {} as Schedule,
      isValid: false,
      error: executeAt.error ?? 'Failed to parse time',
    };
  }

  // Find next occurrence of this day of month
  const nextDate = getNextMonthDay(dayOfMonth, executeAt.time);

  return {
    schedule: {
      type: 'recurring',
      executeAt: nextDate,
      recurrence: {
        pattern: 'monthly' as RecurrencePattern,
        interval: 1,
        dayOfMonth,
      },
      timezone,
    },
    isValid: true,
  };
}

function parseOnce(dateStr: string, timeStr: string, timezone: string): ParsedSchedule {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    return {
      schedule: {} as Schedule,
      isValid: false,
      error: `Invalid date: ${dateStr}`,
    };
  }

  const executeAt = parseTime(timeStr, timezone);
  if (!executeAt.isValid || !executeAt.time) {
    return {
      schedule: {} as Schedule,
      isValid: false,
      error: executeAt.error ?? 'Failed to parse time',
    };
  }

  // Combine date and time
  const finalDate = new Date(date);
  finalDate.setHours(executeAt.time.getHours(), executeAt.time.getMinutes(), 0, 0);

  return {
    schedule: {
      type: 'once',
      executeAt: finalDate,
      timezone,
    },
    isValid: true,
  };
}

interface ParsedTime {
  isValid: boolean;
  time?: Date;
  error?: string;
}

function parseTime(timeStr: string, timezone?: string): ParsedTime {
  const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!timeMatch) {
    return {
      isValid: false,
      error: `Invalid time format: ${timeStr}. Use HH:MM format.`,
    };
  }

  const hours = parseInt(timeMatch[1]);
  const minutes = parseInt(timeMatch[2]);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return {
      isValid: false,
      error: `Invalid time: ${timeStr}. Hours must be 0-23, minutes 0-59.`,
    };
  }

  // Use timezone parameter for proper timezone-aware date creation
  const now = timezone
    ? new Date(new Date().toLocaleString('en-US', { timeZone: timezone }))
    : new Date();
  now.setHours(hours, minutes, 0, 0);

  return { isValid: true, time: now };
}

function parseDayOfWeek(dayStr: string): number {
  const days: Record<string, number> = {
    sunday: 0,
    sun: 0,
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    tues: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    thurs: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6,
  };

  return days[dayStr.toLowerCase()] ?? -1;
}

function getNextWeekday(targetDay: number, time: Date): Date {
  const now = new Date();
  const currentDay = now.getDay();

  // Check if the target time has already passed today
  const todayTargetTime = new Date(now);
  todayTargetTime.setHours(time.getHours(), time.getMinutes(), 0, 0);
  const hasTimePassed = now >= todayTargetTime;

  let daysUntilTarget = targetDay - currentDay;
  if (daysUntilTarget < 0 || (daysUntilTarget === 0 && hasTimePassed)) {
    daysUntilTarget += 7; // Next week
  }

  const nextDate = new Date(now);
  nextDate.setDate(now.getDate() + daysUntilTarget);
  nextDate.setHours(time.getHours(), time.getMinutes(), 0, 0);

  return nextDate;
}

/**
 * Get the last day of a given month
 */
function getLastDayOfMonth(year: number, month: number): number {
  // Create a date for the first day of the next month, then go back one day
  return new Date(year, month + 1, 0).getDate();
}

/**
 * Clamp the target day to the last valid day of the month
 * This handles cases like scheduling for day 31 in months with fewer days
 */
function clampDayToMonth(targetDay: number, year: number, month: number): number {
  const lastDay = getLastDayOfMonth(year, month);
  return Math.min(targetDay, lastDay);
}

function getNextMonthDay(targetDay: number, time: Date): Date {
  const now = new Date();
  const currentDay = now.getDate();

  // Check if the target time has already passed today
  const todayTargetTime = new Date(now);
  todayTargetTime.setHours(time.getHours(), time.getMinutes(), 0, 0);
  const hasTimePassed = now >= todayTargetTime;

  const nextDate = new Date(now);

  // Clamp target day to valid day for current month
  const clampedTargetDayThisMonth = clampDayToMonth(targetDay, now.getFullYear(), now.getMonth());

  if (clampedTargetDayThisMonth > currentDay) {
    // Target day is later this month (clamped to valid day)
    nextDate.setDate(clampedTargetDayThisMonth);
  } else if (clampedTargetDayThisMonth === currentDay && !hasTimePassed) {
    // Today is the target day and time hasn't passed yet
    nextDate.setDate(clampedTargetDayThisMonth);
  } else {
    // Target day has passed this month, go to next month
    const nextMonth = now.getMonth() + 1;
    const nextYear = nextMonth > 11 ? now.getFullYear() + 1 : now.getFullYear();
    const normalizedMonth = nextMonth % 12;

    // Clamp target day to valid day for next month
    const clampedTargetDayNextMonth = clampDayToMonth(targetDay, nextYear, normalizedMonth);

    nextDate.setFullYear(nextYear);
    nextDate.setMonth(normalizedMonth);
    nextDate.setDate(clampedTargetDayNextMonth);
  }

  nextDate.setHours(time.getHours(), time.getMinutes(), 0, 0);

  return nextDate;
}
