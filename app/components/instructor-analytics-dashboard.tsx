import { Link, useFetcher, useSearchParams } from "react-router";
import { BarChart3 } from "lucide-react";
import { WeeklyEnrollmentChart } from "~/components/weekly-enrollment-chart";
import type { AtRiskStudent, ContentAnalytics, OverviewStats, RevenueStats, WeeklyEnrollment } from "~/services/instructorAnalyticsService";
import { RevenueTab } from "~/components/instructor-analytics-revenue";
import { ContentTab } from "~/components/lesson-funnel-chart";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

type Props = {
  isAdmin: boolean;
  instructors: { id: number; name: string }[];
  selectedInstructorId: number | null;
  overview: OverviewStats;
  weeklyEnrollments: WeeklyEnrollment[];
  revenue: RevenueStats;
  content: ContentAnalytics;
  atRiskStudents: AtRiskStudent[];
  atRiskThreshold: { days: number; editable: boolean };
};

function AtRiskThresholdControl({ days, editable }: { days: number; editable: boolean }) {
  const fetcher = useFetcher<{ error?: string; ok?: boolean }>();
  const error = fetcher.data?.error;
  return (
    <fetcher.Form method="post" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="intent" value="set-at-risk-threshold" />
      <div className="space-y-1">
        <Label htmlFor="at-risk-threshold">At-risk after (days inactive)</Label>
        <Input
          id="at-risk-threshold"
          name="days"
          type="number"
          min={3}
          max={90}
          defaultValue={days}
          key={days}
          readOnly={!editable}
          disabled={!editable}
          className="w-28"
          aria-invalid={error ? true : undefined}
        />
      </div>
      {editable ? (
        <Button type="submit" disabled={fetcher.state !== "idle"}>
          Save
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          This instructor's threshold (read-only).
        </p>
      )}
      {error && <p className="w-full text-sm text-destructive">{error}</p>}
    </fetcher.Form>
  );
}

function AtRiskList({ students, days }: { students: AtRiskStudent[]; days: number }) {
  if (students.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
        No students are at risk. Everyone has been active in the last {days} days.
      </div>
    );
  }
  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">At-risk students</h2>
        <p className="text-sm text-muted-foreground">
          Inactive for more than {days} days, longest inactivity first.
        </p>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="pb-2 font-medium">Student</th>
              <th className="pb-2 font-medium">Course</th>
              <th className="pb-2 font-medium">Progress</th>
              <th className="pb-2 font-medium">Last active</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {students.map((s) => (
              <tr key={`${s.userId}:${s.courseId}`} className="border-t">
                <td className="py-2">{s.name}</td>
                <td className="py-2">{s.courseTitle}</td>
                <td className="py-2">{formatPct(s.progress)}</td>
                <td className="py-2">{new Date(s.lastActiveAt).toLocaleDateString()}</td>
                <td className="py-2 text-right">
                  <Link
                    to={`/instructor/${s.courseId}/students`}
                    className="text-primary hover:underline"
                  >
                    View roster
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

const ALL = "all";

function formatPct(value: number) {
  return `${Math.round(value)}%`;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2 text-sm text-muted-foreground">{label}</CardHeader>
      <CardContent>
        <div className="text-3xl font-bold">{value}</div>
        {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function Placeholder({ title }: { title: string }) {
  return (
    <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
      {title} analytics are coming soon.
    </div>
  );
}

export function InstructorAnalyticsDashboard({
  isAdmin,
  instructors,
  selectedInstructorId,
  overview,
  weeklyEnrollments,
  revenue,
  content,
  atRiskStudents,
  atRiskThreshold,
}: Props) {
  const [searchParams, setSearchParams] = useSearchParams();

  function onInstructorChange(value: string) {
    const next = new URLSearchParams(searchParams);
    next.delete("courseId");
    if (value === ALL) next.delete("instructorId");
    else next.set("instructorId", value);
    setSearchParams(next);
  }

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Analytics</h1>
          <p className="mt-1 text-muted-foreground">
            {isAdmin && selectedInstructorId === null
              ? "Platform-wide performance"
              : "How your courses are performing"}
          </p>
        </div>
        {isAdmin && (
          <Select
            value={selectedInstructorId === null ? ALL : String(selectedInstructorId)}
            onValueChange={onInstructorChange}
          >
            <SelectTrigger className="w-64" aria-label="Instructor">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All instructors</SelectItem>
              {instructors.map((i) => (
                <SelectItem key={i.id} value={String(i.id)}>
                  {i.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {overview.courseCount === 0 && !isAdmin ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <BarChart3 className="mx-auto mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">No courses yet</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Publish a course to start seeing analytics.
          </p>
          <Link to="/instructor/new">
            <Button>Create a course</Button>
          </Link>
        </div>
      ) : (
        <Tabs defaultValue={searchParams.has("courseId") ? "content" : "overview"}>
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="students">Students</TabsTrigger>
            <TabsTrigger value="content">Content</TabsTrigger>
            <TabsTrigger value="revenue">Revenue</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="mt-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Unique students"
                value={String(overview.uniqueStudents)}
                sub={`+${overview.newStudentsLast30Days} in the last 30 days`}
              />
              <StatCard label="Average progress" value={formatPct(overview.averageProgress)} />
              <StatCard label="Completion rate" value={formatPct(overview.completionRate)} />
              <StatCard
                label="Quiz pass rate"
                value={formatPct(overview.quizPassRate)}
                sub={`Average score ${formatPct(overview.averageQuizScore)}`}
              />
            </div>
          </TabsContent>
          <TabsContent value="students" className="mt-6">
            <div className="space-y-6">
              <WeeklyEnrollmentChart weeks={weeklyEnrollments} />
              <AtRiskThresholdControl {...atRiskThreshold} />
              <AtRiskList students={atRiskStudents} days={atRiskThreshold.days} />
            </div>
          </TabsContent>
          <TabsContent value="content" className="mt-6">
            <ContentTab content={content} />
          </TabsContent>
          <TabsContent value="revenue" className="mt-6">
            <RevenueTab revenue={revenue} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
