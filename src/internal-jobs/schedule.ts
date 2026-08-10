import type { InternalScheduleTiming } from "./contracts.js";

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly weekday: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function nextScheduleOccurrence(
  timing: InternalScheduleTiming,
  after: Date,
  excludedWallClockSlot?: string,
): string | undefined {
  if (timing.kind === "once") {
    return Date.parse(timing.runAt) > after.getTime()
      ? new Date(timing.runAt).toISOString()
      : timing.runAt;
  }
  if (timing.kind === "interval") {
    const anchor = Date.parse(timing.anchorAt);
    const interval = timing.everyMinutes * 60_000;
    if (anchor > after.getTime()) return new Date(anchor).toISOString();
    const elapsed = after.getTime() - anchor;
    return new Date(
      anchor + (Math.floor(elapsed / interval) + 1) * interval,
    ).toISOString();
  }
  return nextWallClockOccurrence(timing, after, excludedWallClockSlot);
}

export function scheduleWallClockSlot(
  timing: InternalScheduleTiming,
  instant: string,
): string | undefined {
  if (timing.kind !== "daily" && timing.kind !== "weekly") return undefined;
  const parts = zonedParts(new Date(instant), timing.timeZone);
  return wallClockSlot(parts.year, parts.month, parts.day, timing.timeOfDay);
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function nextWallClockOccurrence(
  timing: Extract<InternalScheduleTiming, { kind: "daily" | "weekly" }>,
  after: Date,
  excludedWallClockSlot?: string,
): string {
  const [hourText, minuteText] = timing.timeOfDay.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const start = zonedParts(after, timing.timeZone);
  const startDate = Date.UTC(start.year, start.month - 1, start.day);
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = new Date(startDate + offset * 86_400_000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const weekday = date.getUTCDay();
    if (timing.kind === "weekly" && !timing.weekdays.includes(weekday)) {
      continue;
    }
    const slot = wallClockSlot(year, month, day, timing.timeOfDay);
    if (slot === excludedWallClockSlot) continue;
    const candidates = instantsForLocalTime(
      year,
      month,
      day,
      hour,
      minute,
      timing.timeZone,
    );
    const exact = candidates.filter((candidate) => candidate > after.getTime());
    if (exact[0] !== undefined) return new Date(exact[0]).toISOString();
    if (candidates.length === 0) {
      const shifted = firstValidMinuteAfterGap(
        year,
        month,
        day,
        hour,
        minute,
        timing.timeZone,
        after.getTime(),
      );
      if (shifted !== undefined) return new Date(shifted).toISOString();
    }
  }
  throw new RangeError("Unable to calculate the next scheduled occurrence.");
}

function firstValidMinuteAfterGap(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
  after: number,
): number | undefined {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  for (let shift = 1; shift <= 180; shift += 1) {
    const shifted = new Date(target + shift * 60_000);
    if (
      shifted.getUTCFullYear() !== year ||
      shifted.getUTCMonth() + 1 !== month ||
      shifted.getUTCDate() !== day
    ) {
      return undefined;
    }
    const candidates = instantsForLocalTime(
      year,
      month,
      day,
      shifted.getUTCHours(),
      shifted.getUTCMinutes(),
      timeZone,
    ).filter((candidate) => candidate > after);
    if (candidates[0] !== undefined) return candidates[0];
  }
  return undefined;
}

function instantsForLocalTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): readonly number[] {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();
  for (const sample of [naive - 129_600_000, naive, naive + 129_600_000]) {
    offsets.add(timeZoneOffsetMilliseconds(sample, timeZone));
  }
  const candidates = [...offsets]
    .map((offset) => naive - offset)
    .filter((candidate) => {
      const parts = zonedParts(new Date(candidate), timeZone);
      return (
        parts.year === year &&
        parts.month === month &&
        parts.day === day &&
        parts.hour === hour &&
        parts.minute === minute
      );
    });
  return [...new Set(candidates)].sort((left, right) => left - right);
}

function timeZoneOffsetMilliseconds(instant: number, timeZone: string): number {
  const rounded = Math.floor(instant / 1000) * 1000;
  const parts = zonedParts(new Date(rounded), timeZone);
  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) - rounded
  );
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: WEEKDAY_INDEX[values.weekday ?? ""] ?? 0,
  };
}

function wallClockSlot(
  year: number,
  month: number,
  day: number,
  timeOfDay: string,
): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${timeOfDay}`;
}
