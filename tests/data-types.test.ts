import { describe, expect, it } from "vitest";
import { DataTypes } from "../src/data-types";

describe("DataTypes.filter", () => {
  it("bounds interval types on their civil start time", () => {
    expect(DataTypes.filter("steps", "2026-10-01", "2026-10-02")).toBe(
      'steps.interval.civil_start_time >= "2026-10-01" AND steps.interval.civil_start_time < "2026-10-02"',
    );
  });

  it("names types in snake_case and bounds samples on their civil time", () => {
    expect(DataTypes.filter("heart-rate", "2026-10-01T08:00:00")).toBe(
      'heart_rate.sample_time.civil_time >= "2026-10-01T08:00:00"',
    );
  });

  it("matches daily types on the date alone", () => {
    expect(DataTypes.filter("daily-resting-heart-rate", undefined, "2026-10-02T12:00:00")).toBe(
      'daily_resting_heart_rate.date < "2026-10-02"',
    );
  });

  it("matches sleep on the day it ended", () => {
    expect(DataTypes.filter("sleep", "2026-10-01")).toBe(
      'sleep.interval.civil_end_time >= "2026-10-01"',
    );
  });

  it("gives ECG only a physical lower bound", () => {
    expect(DataTypes.filter("electrocardiogram", "2026-10-01", "2026-10-05")).toBe(
      'electrocardiogram.interval.start_time >= "2026-10-01T00:00:00Z"',
    );
  });

  it("has no filter without a range or for food", () => {
    expect(DataTypes.filter("weight")).toBeUndefined();
    expect(DataTypes.filter("food", "2026-10-01")).toBeUndefined();
  });
});

describe("DataTypes methods", () => {
  it("prefers reconcile and falls back to list", () => {
    expect(DataTypes.readMethod("steps")).toBe("reconcile");
    expect(DataTypes.readMethod("electrocardiogram")).toBe("list");
  });

  it("offers each tool only the types its method supports", () => {
    expect(DataTypes.supporting("dailyRollUp")).toContain("total-calories");
    expect(DataTypes.supporting("dailyRollUp")).not.toContain("sleep");
    expect(DataTypes.supporting("list", "reconcile")).not.toContain("total-calories");
  });

  it("caps sleep and exercise pages at 25", () => {
    expect(DataTypes.pageSize("sleep", 100)).toBe(25);
    expect(DataTypes.pageSize("steps", 100)).toBe(100);
  });
});
