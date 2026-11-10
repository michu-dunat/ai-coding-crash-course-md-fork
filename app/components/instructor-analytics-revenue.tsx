import type { RevenueStats } from "~/services/instructorAnalyticsService";
import { formatPrice } from "~/lib/utils";
import { Card, CardContent, CardHeader } from "~/components/ui/card";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2 text-sm text-muted-foreground">{label}</CardHeader>
      <CardContent>
        <div className="text-3xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}

function RevenueTable({
  heading,
  label,
  rows,
}: {
  heading: string;
  label: string;
  rows: { key: string; name: string; purchases: number; revenue: number }[];
}) {
  return (
    <div>
      <h3 className="mb-2 font-medium">{heading}</h3>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="p-3 font-medium">{label}</th>
              <th className="p-3 text-right font-medium">Purchases</th>
              <th className="p-3 text-right font-medium">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t">
                <td className="p-3">{r.name}</td>
                <td className="p-3 text-right">{r.purchases}</td>
                <td className="p-3 text-right">{formatPrice(r.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RevenueTab({ revenue }: { revenue: RevenueStats }) {
  if (revenue.purchaseCount === 0) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
        No purchases yet.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Total revenue" value={formatPrice(revenue.totalRevenue)} />
        <Stat label="Last 30 days" value={formatPrice(revenue.revenueLast30Days)} />
        <Stat
          label="Team seats redeemed"
          value={`${revenue.teamSeats.redeemed} / ${revenue.teamSeats.total}`}
        />
      </div>
      <RevenueTable
        heading="Revenue per course"
        label="Course"
        rows={revenue.byCourse.map((c) => ({
          key: String(c.courseId),
          name: c.title,
          purchases: c.purchases,
          revenue: c.revenue,
        }))}
      />
      <RevenueTable
        heading="Revenue by country"
        label="Country"
        rows={revenue.byCountry.map((c) => ({
          key: c.country ?? "unknown",
          name: c.country ?? "Unknown",
          purchases: c.purchases,
          revenue: c.revenue,
        }))}
      />
    </div>
  );
}
