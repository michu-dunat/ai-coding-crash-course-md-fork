import type { HardQuestion } from "~/services/hardestQuestionsService";
import { Card, CardContent, CardHeader } from "~/components/ui/card";

export function HardestQuestionsTable({ questions }: { questions: HardQuestion[] }) {
  return (
    <Card>
      <CardHeader>
        <h2 className="font-semibold">Hardest quiz questions</h2>
        <p className="text-sm text-muted-foreground">
          Highest wrong-answer rate across all attempts (min. 3 answers)
        </p>
      </CardHeader>
      <CardContent>
        {questions.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-muted-foreground">
            No quiz questions with enough answers yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">Question</th>
                <th className="pb-2 font-medium">Lesson</th>
                <th className="pb-2 text-right font-medium">Wrong</th>
                <th className="pb-2 text-right font-medium">Answers</th>
              </tr>
            </thead>
            <tbody>
              {questions.map((q) => (
                <tr key={q.questionId} className="border-t">
                  <td className="py-2 pr-4">{q.questionText}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{q.lessonTitle}</td>
                  <td className="py-2 text-right tabular-nums">{Math.round(q.wrongRate)}%</td>
                  <td className="py-2 text-right tabular-nums">{q.answerCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
