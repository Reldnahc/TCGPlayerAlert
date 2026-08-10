export type InternalScheduleTiming =
  | { readonly kind: "once"; readonly runAt: string }
  | {
      readonly kind: "interval";
      readonly everyMinutes: number;
      readonly anchorAt: string;
    }
  | {
      readonly kind: "daily";
      readonly timeOfDay: string;
      readonly timeZone: string;
    }
  | {
      readonly kind: "weekly";
      readonly weekdays: readonly number[];
      readonly timeOfDay: string;
      readonly timeZone: string;
    };

export interface ScheduledListingItem {
  readonly productId: number;
  readonly productConditionId: number;
  readonly productName: string;
  readonly quantity: number;
}

export interface AutomaticRepricingLimits {
  readonly maximumUpdates: number;
  readonly maximumDecreasePercent: number;
  readonly maximumDecreaseAmount: number;
  readonly maximumIncreasePercent: number;
  readonly maximumBlockedPercent: number;
}

export type InternalSchedulePayload =
  | {
      readonly type: "reprice-inventory";
      readonly pricingProfileId: string;
      readonly mode: "review" | "automatic";
      readonly scope: "all";
      readonly limits: AutomaticRepricingLimits;
    }
  | {
      readonly type: "list-inventory";
      readonly merchandiseProfileId: string;
      readonly items: readonly ScheduledListingItem[];
    };

export interface InternalSchedule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly timing: InternalScheduleTiming;
  readonly payload: InternalSchedulePayload;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly lastRunId?: string;
}

export type InternalRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "review-required"
  | "canceled"
  | "skipped";

export type InternalRunReportOutcome =
  "queued" | "proposed" | "unchanged" | "skipped" | "review-required";

export interface InternalRunReportItem {
  readonly key: string;
  readonly productName: string;
  readonly outcome: InternalRunReportOutcome;
  readonly quantity?: number;
  readonly currentPrice?: number;
  readonly proposedPrice?: number;
  readonly reason?: string;
}

export interface InternalRunReport {
  readonly proposed: number;
  readonly queuedPriceJobs: number;
  readonly queuedInventoryJobs: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly reviewRequired: number;
  readonly truncatedItems: number;
  readonly items: readonly InternalRunReportItem[];
}

export interface InternalRun {
  readonly id: string;
  readonly scheduleId: string;
  readonly scheduleName: string;
  readonly payload: InternalSchedulePayload;
  readonly trigger: "scheduled" | "manual";
  readonly status: InternalRunStatus;
  readonly scheduledFor: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly nextAttemptAt?: string;
  readonly attempts: number;
  readonly report?: InternalRunReport;
  readonly errorCode?: string;
}

export interface InternalJobSnapshot {
  readonly schedules: readonly InternalSchedule[];
  readonly runs: readonly InternalRun[];
}

export interface InternalScheduleInput {
  readonly name: string;
  readonly enabled: boolean;
  readonly timing: InternalScheduleTiming;
  readonly payload: InternalSchedulePayload;
}

export interface ScheduledListingInput {
  readonly runAt: string;
  readonly merchandiseProfileId: string;
  readonly item: ScheduledListingItem;
}

export const EMPTY_INTERNAL_RUN_REPORT: InternalRunReport = {
  proposed: 0,
  queuedPriceJobs: 0,
  queuedInventoryJobs: 0,
  unchanged: 0,
  skipped: 0,
  reviewRequired: 0,
  truncatedItems: 0,
  items: [],
};
