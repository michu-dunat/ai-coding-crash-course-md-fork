import { Link, useSearchParams } from "react-router";
import { BarChart3 } from "lucide-react";
import type { OverviewStats } from "~/services/instructorAnalyticsService";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
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
};

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
}: Props) {
  const [searchParams, setSearchParams] = useSearchParams();

  function onInstructorChange(value: string) {
    const next = new URLSearchParams(searchParams);
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
        <Tabs defaultValue="overview">
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
            <Placeholder title="Student" />
          </TabsContent>
          <TabsContent value="content" className="mt-6">
            <Placeholder title="Content" />
          </TabsContent>
          <TabsContent value="revenue" className="mt-6">
            <Placeholder title="Revenue" />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
