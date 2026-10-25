import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DataTypes } from "./data-types";
import { GoogleHealthApi, GoogleHealthError } from "./google-health";

const civilTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/)
  .describe("Local time in the user's time zone: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Local date in the user's time zone: YYYY-MM-DD");
const timestamp = z.iso.datetime({ offset: true }).describe("RFC 3339 timestamp with an offset");
const pageSize = z.number().int().min(1).max(500).default(100).describe("Points per page");
const pageToken = z.string().optional().describe("nextPageToken from the previous call");

const readOnly = { readOnlyHint: true, openWorldHint: false };

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Returns API data as compact JSON, and Google's failures as tool errors the model can act on. */
async function respond(read: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await read();
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  } catch (error) {
    if (!(error instanceof GoogleHealthError)) throw error;
    return { content: [{ type: "text", text: error.message }], isError: true };
  }
}

/** The MCP server for one request, reading Google Health data with the caller's access token. */
export function createServer(accessToken: string): McpServer {
  const api = new GoogleHealthApi(accessToken);
  const server = new McpServer({ name: "google-health-mcp", version: "0.1.0" });

  server.registerTool(
    "get_profile",
    {
      title: "Get profile and settings",
      description:
        "The user's Google Health profile (age, stride lengths, member since) and settings (time zone, UTC offset, units). Read the time zone before building time ranges.",
      annotations: readOnly,
    },
    () =>
      respond(async () => ({
        profile: await api.getProfile(),
        settings: await api.getSettings(),
      })),
  );

  server.registerTool(
    "list_devices",
    {
      title: "List paired devices",
      description:
        "Fitbit and Pixel Watch trackers and scales paired with the account, with battery and last sync time.",
      annotations: readOnly,
    },
    () => respond(() => api.listPairedDevices()),
  );

  server.registerTool(
    "get_data_points",
    {
      title: "Get data points",
      description: [
        "Individual readings, sessions or daily values for one data type, newest first, merged across devices where the API supports it.",
        "Without a range it returns the most recent points. Daily types match on the date; sleep matches on the day the sleep ended; electrocardiogram takes only a start, read as UTC.",
        "Dense series such as heart-rate hold a point per second: use get_daily_summary or get_rollup for trends.",
      ].join(" "),
      inputSchema: z.object({
        dataType: z.enum(DataTypes.supporting("list", "reconcile")),
        start: civilTime.optional().describe("Inclusive start, local time"),
        end: civilTime.optional().describe("Exclusive end, local time"),
        pageSize,
        pageToken,
      }),
      annotations: readOnly,
    },
    ({ dataType, start, end, pageSize, pageToken }) =>
      respond(() =>
        api.readDataPoints(dataType, DataTypes.readMethod(dataType), {
          filter: DataTypes.filter(dataType, start, end),
          pageSize: DataTypes.pageSize(dataType, pageSize),
          pageToken,
        }),
      ),
  );

  server.registerTool(
    "get_daily_summary",
    {
      title: "Get daily summary",
      description:
        "Totals or statistics per local day (or per window of days) for one data type. The range may span at most 90 days, or 14 days for heart-rate, total-calories, calories-in-heart-rate-zone and active-minutes.",
      inputSchema: z.object({
        dataType: z.enum(DataTypes.supporting("dailyRollUp")),
        startDate: date.describe("First day, inclusive"),
        endDate: date.describe("Last day, inclusive"),
        windowDays: z.number().int().min(1).max(90).default(1).describe("Days per bucket"),
        pageToken,
      }),
      annotations: readOnly,
    },
    ({ dataType, startDate, endDate, windowDays, pageToken }) =>
      respond(() =>
        api.dailyRollUp(
          dataType,
          // The API's end is exclusive; the tool's last day is inclusive.
          { startDate, endDate: nextDay(endDate), windowSizeDays: windowDays },
          { pageSize: 100, pageToken },
        ),
      ),
  );

  server.registerTool(
    "get_rollup",
    {
      title: "Get rollup",
      description:
        "Totals or statistics per fixed window of time (for example hourly heart rate) for one data type. The range may span at most 90 days, or 14 days for heart-rate, total-calories, calories-in-heart-rate-zone and active-minutes.",
      inputSchema: z.object({
        dataType: z.enum(DataTypes.supporting("rollUp")),
        startTime: timestamp.describe("Inclusive start"),
        endTime: timestamp.describe("Exclusive end"),
        windowMinutes: z.number().int().min(1).describe("Minutes per bucket"),
        pageSize,
        pageToken,
      }),
      annotations: readOnly,
    },
    ({ dataType, startTime, endTime, windowMinutes, pageSize, pageToken }) =>
      respond(() =>
        api.rollUp(
          dataType,
          { startTime, endTime, windowSeconds: windowMinutes * 60 },
          { pageSize, pageToken },
        ),
      ),
  );

  return server;
}

function nextDay(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}
