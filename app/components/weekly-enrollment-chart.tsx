import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { TrendingUp } from "lucide-react";
import type { WeeklyEnrollment } from "~/services/instructorAnalyticsService";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart";

const chartConfig = {
  count: { label: "New enrollments", color: "var(--chart-1)" },
} satisfies ChartConfig;

function formatWeek(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function WeeklyEnrollmentChart({ weeks }: { weeks: WeeklyEnrollment[] }) {
  const total = weeks.reduce((sum, w) => sum + w.count, 0);

  return (
    <Card>
      <CardHeader>
        <h2 className="font-semibold">Weekly enrollments</h2>
        <p className="text-sm text-muted-foreground">New enrollments per week, last 12 weeks</p>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
            <TrendingUp className="mx-auto mb-4 size-10 text-muted-foreground/50" />
            No enrollments in the last 12 weeks.
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-64 w-full">
            <BarChart data={weeks} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="weekStart"
                tickFormatter={formatWeek}
                tickLine={false}
                axisLine={false}
              />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
              <ChartTooltip
                content={<ChartTooltipContent labelFormatter={(v) => `Week of ${formatWeek(String(v))}`} />}
              />
              <Bar dataKey="count" fill="var(--color-count)" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
