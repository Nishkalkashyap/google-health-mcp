/** The Google Health API v4 methods a data type can be read with. */
type ReadMethod = "list" | "reconcile" | "rollUp" | "dailyRollUp";

interface DataType {
  /** The `dataPoints.list` filter field that bounds a time range, or null when the type has none. */
  timeField: string | null;
  methods: readonly ReadMethod[];
}

const all: readonly ReadMethod[] = ["list", "reconcile", "rollUp", "dailyRollUp"];
const points: readonly ReadMethod[] = ["list", "reconcile"];
const rollUpsOnly: readonly ReadMethod[] = ["rollUp", "dailyRollUp"];

const interval = "interval.civil_start_time";
const sample = "sample_time.civil_time";
const daily = "date";

/**
 * Every data type a read-only scope can reach, from https://developers.google.com/health/data-types.
 * Types that are write-only (moods, symptoms, menstrual-period, ovulation-test) or v4beta are left out.
 */
const catalog = {
  "active-energy-burned": { timeField: interval, methods: all },
  "active-minutes": { timeField: interval, methods: all },
  "active-zone-minutes": { timeField: interval, methods: all },
  "activity-level": { timeField: interval, methods: points },
  altitude: { timeField: interval, methods: all },
  "blood-glucose": { timeField: sample, methods: all },
  "body-fat": { timeField: sample, methods: all },
  "calories-in-heart-rate-zone": { timeField: interval, methods: rollUpsOnly },
  "core-body-temperature": { timeField: sample, methods: all },
  "daily-heart-rate-variability": { timeField: daily, methods: points },
  "daily-heart-rate-zones": { timeField: daily, methods: points },
  "daily-oxygen-saturation": { timeField: daily, methods: points },
  "daily-respiratory-rate": { timeField: daily, methods: points },
  "daily-resting-heart-rate": { timeField: daily, methods: points },
  "daily-sleep-temperature-derivations": { timeField: daily, methods: points },
  "daily-vo2-max": { timeField: daily, methods: points },
  distance: { timeField: interval, methods: all },
  // ECG accepts only a lower bound, on physical time.
  electrocardiogram: { timeField: "interval.start_time", methods: ["list"] },
  exercise: { timeField: interval, methods: points },
  floors: { timeField: interval, methods: ["reconcile", "rollUp", "dailyRollUp"] },
  food: { timeField: null, methods: ["list"] },
  "food-measurement-unit": { timeField: null, methods: ["list"] },
  "heart-rate": { timeField: sample, methods: all },
  "heart-rate-variability": { timeField: sample, methods: points },
  height: { timeField: sample, methods: points },
  "hydration-log": { timeField: interval, methods: all },
  "irregular-rhythm-notification": { timeField: interval, methods: ["list"] },
  "nutrition-log": { timeField: interval, methods: all },
  "oxygen-saturation": { timeField: sample, methods: points },
  "respiratory-rate-sleep-summary": { timeField: sample, methods: points },
  "run-vo2-max": { timeField: sample, methods: all },
  "sedentary-period": { timeField: interval, methods: all },
  // A night belongs to the day it ends on.
  sleep: { timeField: "interval.civil_end_time", methods: points },
  steps: { timeField: interval, methods: all },
  "swim-lengths-data": { timeField: interval, methods: all },
  "time-in-heart-rate-zone": { timeField: interval, methods: all },
  "total-calories": { timeField: interval, methods: rollUpsOnly },
  "vo2-max": { timeField: sample, methods: points },
  weight: { timeField: sample, methods: all },
} satisfies Record<string, DataType>;

export type DataTypeId = keyof typeof catalog;

const ids = Object.keys(catalog) as DataTypeId[];

export class DataTypes {
  /** The IDs that support any of the methods, as a non-empty tuple for `z.enum`. */
  static supporting(...methods: ReadMethod[]): [DataTypeId, ...DataTypeId[]] {
    const supported = ids.filter((id) =>
      DataTypes._methods(id).some((method) => methods.includes(method)),
    );
    const [first, ...rest] = supported;
    if (!first) throw new Error(`No data type supports ${methods.join(", ")}`);
    return [first, ...rest];
  }

  /** `reconcile` merges overlapping sources, so prefer it and fall back to raw `list`. */
  static readMethod(id: DataTypeId): "list" | "reconcile" {
    return DataTypes._methods(id).includes("reconcile") ? "reconcile" : "list";
  }

  /** Sleep and exercise are capped at 25 points per page by the API. */
  static pageSize(id: DataTypeId, requested: number): number {
    if (id === "sleep" || id === "exercise") return Math.min(requested, 25);
    return requested;
  }

  /**
   * Builds the AIP-160 filter for a civil time range: `start` inclusive, `end` exclusive, each
   * `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm:ss` in the user's local time.
   */
  static filter(id: DataTypeId, start?: string, end?: string): string | undefined {
    const timeField = catalog[id].timeField;
    if (!timeField) return undefined;
    // Filters name the type in snake_case; paths use kebab-case.
    const field = `${id.replaceAll("-", "_")}.${timeField}`;
    // ECG filters on physical time and has no upper bound, so read the start as UTC.
    if (id === "electrocardiogram") {
      return start ? `${field} >= "${DataTypes._utc(start)}"` : undefined;
    }

    const clauses: string[] = [];
    // Daily types filter on a date, so drop any time of day.
    const value = (time: string) => (timeField === daily ? time.slice(0, 10) : time);
    if (start) clauses.push(`${field} >= "${value(start)}"`);
    if (end) clauses.push(`${field} < "${value(end)}"`);
    return clauses.length > 0 ? clauses.join(" AND ") : undefined;
  }

  private static _methods(id: DataTypeId): readonly ReadMethod[] {
    return catalog[id].methods;
  }

  private static _utc(civil: string): string {
    return civil.length === 10 ? `${civil}T00:00:00Z` : `${civil}Z`;
  }
}
