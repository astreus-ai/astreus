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
          const today = new Date().toISOString().split('T')[0];
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
  const executeAt = parseTime(timeStr);
  if (!executeAt.isValid) {
    return {
      schedule: {} as Schedule,
      isValid: false,
      error: executeAt.error,
    };
  }

  return {
    schedule: {
      type: 'recurring',
      executeAt: executeAt.time!,
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

  const executeAt = parseTime(timeStr);
  if (!executeAt.isValid) {
    return {
      schedule: {} as Schedule,
      isValid: false,
      error: executeAt.error,
    };
  }

  // Find next occurrence of this day
  const nextDate = getNextWeekday(dayOfWeek, executeAt.time!);

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

  const executeAt = parseTime(timeStr);
  if (!executeAt.isValid) {
    return {
      schedule: {} as Schedule,
      isValid: false,
      error: executeAt.error,
    };
  }

  // Find next occurrence of this day of month
  const nextDate = getNextMonthDay(dayOfMonth, executeAt.time!);

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

  const executeAt = parseTime(timeStr);
  if (!executeAt.isValid) {
    return {
      schedule: {} as Schedule,
      isValid: false,
      error: executeAt.error,
    };
  }

  // Combine date and time
  const finalDate = new Date(date);
  finalDate.setHours(executeAt.time!.getHours(), executeAt.time!.getMinutes(), 0, 0);

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

function parseTime(timeStr: string): ParsedTime {
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

  const date = new Date();
  date.setHours(hours, minutes, 0, 0);

  return { isValid: true, time: date };
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

  let daysUntilTarget = targetDay - currentDay;
  if (daysUntilTarget <= 0) {
    daysUntilTarget += 7; // Next week
  }

  const nextDate = new Date(now);
  nextDate.setDate(now.getDate() + daysUntilTarget);
  nextDate.setHours(time.getHours(), time.getMinutes(), 0, 0);

  return nextDate;
}

function getNextMonthDay(targetDay: number, time: Date): Date {
  const now = new Date();
  const currentDay = now.getDate();

  const nextDate = new Date(now);

  if (targetDay <= currentDay) {
    // Next month
    nextDate.setMonth(now.getMonth() + 1);
  }

  nextDate.setDate(targetDay);
  nextDate.setHours(time.getHours(), time.getMinutes(), 0, 0);

  return nextDate;
}
