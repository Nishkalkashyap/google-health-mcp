import { z } from "zod";
import type { DataTypeId } from "./data-types";

const baseUrl = "https://health.googleapis.com/v4/users/me";

const errorBody = z.object({
  error: z.object({ message: z.string(), status: z.string().optional() }),
});

/** A Google Health API failure, with a message that is safe to show the model. */
export class GoogleHealthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Page {
  pageSize: number;
  pageToken?: string;
}

/** A civil date and time in the `CivilDateTime` shape the rollup endpoints take. */
function civilDateTime(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return { date: { year, month, day } };
}

/** Read-only client for the signed-in user's Google Health data. */
export class GoogleHealthApi {
  constructor(private readonly _accessToken: string) {}

  getProfile(): Promise<unknown> {
    return this._get("/profile");
  }

  getSettings(): Promise<unknown> {
    return this._get("/settings");
  }

  listPairedDevices(): Promise<unknown> {
    return this._get("/pairedDevices", { pageSize: "100" });
  }

  /** `list` returns each source's raw points; `reconcile` merges overlapping sources. */
  readDataPoints(
    dataType: DataTypeId,
    method: "list" | "reconcile",
    page: Page & { filter?: string },
  ): Promise<unknown> {
    const suffix = method === "reconcile" ? ":reconcile" : "";
    const query: Record<string, string> = { pageSize: String(page.pageSize) };
    if (page.filter) query.filter = page.filter;
    if (page.pageToken) query.pageToken = page.pageToken;
    return this._get(`/dataTypes/${dataType}/dataPoints${suffix}`, query);
  }

  /** Aggregates whole local days: `startDate` inclusive, `endDate` exclusive. */
  dailyRollUp(
    dataType: DataTypeId,
    range: { startDate: string; endDate: string; windowSizeDays: number },
    page: Page,
  ): Promise<unknown> {
    return this._post(`/dataTypes/${dataType}/dataPoints:dailyRollUp`, {
      range: { start: civilDateTime(range.startDate), end: civilDateTime(range.endDate) },
      windowSizeDays: range.windowSizeDays,
      ...page,
    });
  }

  /** Aggregates fixed windows of physical time between two RFC 3339 timestamps. */
  rollUp(
    dataType: DataTypeId,
    range: { startTime: string; endTime: string; windowSeconds: number },
    page: Page,
  ): Promise<unknown> {
    return this._post(`/dataTypes/${dataType}/dataPoints:rollUp`, {
      range: { startTime: range.startTime, endTime: range.endTime },
      windowSize: `${range.windowSeconds}s`,
      ...page,
    });
  }

  private _get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return this._send(url, { headers: { Authorization: `Bearer ${this._accessToken}` } });
  }

  private _post(path: string, body: object): Promise<unknown> {
    return this._send(new URL(`${baseUrl}${path}`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this._accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  private async _send(url: URL, init: RequestInit): Promise<unknown> {
    const response = await fetch(url, init);
    if (response.ok) return response.json();
    throw await GoogleHealthApi._error(response);
  }

  /** Google's error message names the missing scope or the invalid argument, so pass it on. */
  private static async _error(response: Response): Promise<GoogleHealthError> {
    if (response.status === 401) {
      return new GoogleHealthError(401, "Google rejected the access token. Reconnect this server.");
    }
    const parsed = errorBody.safeParse(await response.json().catch(() => null));
    const message = parsed.success ? parsed.data.error.message : response.statusText;
    return new GoogleHealthError(
      response.status,
      `Google Health API ${response.status}: ${message}`,
    );
  }
}
