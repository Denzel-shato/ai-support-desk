"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ActivityPoint } from "@/lib/types";

const RECEIVED = "#0f6b5c";
const ESCALATED = "#C93A2E";

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { dataKey: string; value: number; payload: ActivityPoint }[];
}) {
  if (!active || !payload?.length) return null;
  const label = payload[0].payload.dateLabel;
  const received = payload.find((p) => p.dataKey === "received")?.value ?? 0;
  const escalated = payload.find((p) => p.dataKey === "escalated")?.value ?? 0;
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-sm">
      <p className="mb-1 font-medium">{label}</p>
      <p className="tabular flex items-center justify-between gap-6 text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: RECEIVED }}
          />
          Received
        </span>
        <span className="font-medium text-foreground">{received}</span>
      </p>
      <p className="tabular flex items-center justify-between gap-6 text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: ESCALATED }}
          />
          Escalated
        </span>
        <span className="font-medium text-foreground">{escalated}</span>
      </p>
    </div>
  );
}

export function TicketActivityChart({
  data,
  rangeLabel,
  total,
  undated,
}: {
  data: ActivityPoint[];
  /** e.g. "7 Nov – 13 Nov"; null when no ticket has a usable date. */
  rangeLabel: string | null;
  total: number;
  /** Tickets with no usable creation date (not plotted). */
  undated: number;
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Ticket activity</CardTitle>
          <CardDescription>
            {rangeLabel ? (
              <>
                <span className="tabular">{total.toLocaleString("en-US")}</span>{" "}
                {total === 1 ? "ticket" : "tickets"} received, {rangeLabel}
                {undated > 0 &&
                  ` · ${undated.toLocaleString("en-US")} without a date not shown`}
              </>
            ) : (
              "Daily ticket volume from creation dates"
            )}
          </CardDescription>
        </div>
        <ul className="flex items-center gap-4 text-xs text-muted-foreground">
          <li className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ backgroundColor: RECEIVED }}
            />
            Received
          </li>
          <li className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ backgroundColor: ESCALATED }}
            />
            Escalated
          </li>
        </ul>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-[240px] items-center justify-center rounded-md border border-dashed border-border-strong bg-surface-muted px-6 text-center text-[13px] text-muted-foreground">
            None of the tickets has a creation date yet, so there is no activity
            to chart.
          </div>
        ) : (
        <div
          className="h-[240px] w-full"
          role="img"
          aria-label={`Line chart of tickets received and escalated per day, ${rangeLabel ?? ""}`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={data}
              margin={{ top: 8, right: 8, bottom: 0, left: -16 }}
            >
              <defs>
                <linearGradient id="receivedFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={RECEIVED} stopOpacity={0.14} />
                  <stop offset="100%" stopColor={RECEIVED} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="#ece9e3" />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 12, fill: "#6b6e75" }}
                dy={6}
              />
              <YAxis
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                width={48}
                tick={{ fontSize: 12, fill: "#6b6e75" }}
              />
              <Tooltip
                content={<ChartTooltip />}
                cursor={{ stroke: "#d9d6cf" }}
              />
              <Area
                type="linear"
                dataKey="received"
                stroke={RECEIVED}
                strokeWidth={2}
                fill="url(#receivedFill)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
              />
              <Line
                type="linear"
                dataKey="escalated"
                stroke={ESCALATED}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        )}
      </CardContent>
    </Card>
  );
}
