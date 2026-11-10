import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { PlayCircle } from "lucide-react";
import type { LessonVideoDropoff } from "~/services/videoDropoffService";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart";

const chartConfig = {
  share: { label: "% of watchers", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function VideoDropoffCard({ lessons }: { lessons: LessonVideoDropoff[] }) {
  return (
    <Card>
      <CardHeader>
        <h2 className="font-semibold">Video drop-off</h2>
        <p className="text-sm text-muted-foreground">
          Share of watching students whose furthest position reached each 10% of the video
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {lessons.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
            <PlayCircle className="mx-auto mb-4 size-10 text-muted-foreground/50" />
            No video watch events for this course yet.
          </div>
        ) : (
          lessons.map((lesson) => (
            <div key={lesson.lessonId}>
              <div className="mb-2 flex items-baseline justify-between gap-4">
                <h3 className="text-sm font-medium">{lesson.title}</h3>
                <span className="text-xs text-muted-foreground">
                  {lesson.watchers} {lesson.watchers === 1 ? "watcher" : "watchers"}
                </span>
              </div>
              {lesson.steps === null ? (
                <p className="text-sm italic text-muted-foreground">No duration set</p>
              ) : (
                <ChartContainer config={chartConfig} className="h-40 w-full">
                  <BarChart
                    data={lesson.steps.map((s) => ({
                      label: `${s.percent}%`,
                      share: Math.round(s.share),
                    }))}
                    accessibilityLayer
                  >
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} />
                    <YAxis
                      domain={[0, 100]}
                      tickFormatter={(v: number) => `${v}%`}
                      tickLine={false}
                      axisLine={false}
                      width={40}
                    />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="share" fill="var(--color-share)" radius={4} />
                  </BarChart>
                </ChartContainer>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
