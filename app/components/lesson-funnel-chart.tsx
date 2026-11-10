import { useSearchParams } from "react-router";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { BookOpen } from "lucide-react";
import type { ContentAnalytics } from "~/services/instructorAnalyticsService";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

const chartConfig = {
  completions: { label: "Completed", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function ContentTab({ content }: { content: ContentAnalytics }) {
  const [searchParams, setSearchParams] = useSearchParams();

  if (content.selectedCourseId === null) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
        No courses to analyze.
      </div>
    );
  }

  function onCourseChange(value: string) {
    const next = new URLSearchParams(searchParams);
    next.set("courseId", value);
    setSearchParams(next, { preventScrollReset: true });
  }

  const data = content.funnel.map((step, i) => ({ ...step, label: `${i + 1}. ${step.title}` }));

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold">Lesson drop-off</h2>
          <p className="text-sm text-muted-foreground">
            Enrolled students who completed each lesson ({content.enrolledStudents} enrolled)
          </p>
        </div>
        <Select value={String(content.selectedCourseId)} onValueChange={onCourseChange}>
          <SelectTrigger className="w-72" aria-label="Course">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {content.courses.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.title} ({c.enrollmentCount})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        {content.enrolledStudents === 0 || data.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
            <BookOpen className="mx-auto mb-4 size-10 text-muted-foreground/50" />
            {data.length === 0
              ? "This course has no lessons yet."
              : "No students enrolled in this course yet."}
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-80 w-full">
            <BarChart data={data} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="label"
                tickFormatter={(v: string) => v.split(".")[0]}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                allowDecimals={false}
                domain={[0, content.enrolledStudents]}
                tickLine={false}
                axisLine={false}
                width={32}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="completions" fill="var(--color-completions)" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
