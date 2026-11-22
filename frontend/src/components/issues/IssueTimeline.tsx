import { useState } from "react";
import { MarkdownTitle } from "./MarkdownEditor";
import type { Issue } from "../../api/issues";

// Do calendar arithmetic in UTC after converting the user's local calendar day to YYYY-MM-DD.
function localDay(d: Date) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}
const dayMs = 86400000;
function dayNumber(date: string) { return Date.parse(date + "T00:00:00Z") / dayMs; }
function range(i: Issue) {
  const start = i.start_date || i.end_date || localDay(new Date(i.created_at));
  return [dayNumber(start), dayNumber(i.end_date || start)];
}
function monday(day: number) { return day - ((new Date(day * dayMs).getUTCDay() + 6) % 7); }
function iso(day: number) { return new Date(day * dayMs).toISOString().slice(0, 10); }

export function IssueTimeline({ issues, open }: { issues: Issue[]; open: (issue: Issue) => void }) {
  const today = dayNumber(localDay(new Date()));
  const [week, setWeek] = useState(() => {
    const current = monday(today);
    const ranges = issues.map(range);
    if (ranges.some(([s, e]) => s <= current + 6 && e >= current) || !ranges.length) return current;
    const closest = ranges.map(([s, e]) => Math.max(s, Math.min(today, e))).sort((a, b) => Math.abs(a - today) - Math.abs(b - today))[0];
    return monday(closest);
  });
  const visible = issues.filter(i => { const [s, e] = range(i); return s <= week + 6 && e >= week; });
  return <section className="issue-timeline">
    <header className="flex flex-wrap items-center gap-2 p-3">
      <strong className="mr-auto text-sm">{iso(week)} — {iso(week + 6)}</strong>
      <button className="issue-action" aria-label="上一周" onClick={() => setWeek(week - 7)}>‹</button>
      <button className="issue-action" onClick={() => setWeek(monday(today))}>本周</button>
      <button className="issue-action" aria-label="下一周" onClick={() => setWeek(week + 7)}>›</button>
      <input aria-label="跳转日期" type="date" value={iso(week)} className="issue-input" onChange={e => { if (e.target.value) setWeek(monday(dayNumber(e.target.value))); }} />
    </header>
    <div className="overflow-x-auto">
      <div className="issue-week">
        {Array.from({ length: 7 }, (_, i) => <div className={`issue-day ${week + i === today ? "today" : ""}`} key={i}>
          <span>周{"一二三四五六日"[i]}</span><strong>{iso(week + i).slice(8)}</strong>
        </div>)}
      </div>
      <div className="issue-lanes">
        {visible.map(i => {
          const [start, end] = range(i);
          return <div className="issue-lane" key={i.id}><button className="issue-bar" style={{ gridColumn: `${Math.max(1, start - week + 1)} / ${Math.min(8, end - week + 2)}`, borderColor: i.status.color }}
            title={i.title + " · " + i.status.name} onClick={() => open(i)}><MarkdownTitle text={i.title} /></button></div>;
        })}
      </div>
    </div>
    {!visible.length && <p className="p-5 text-center text-sm text-[#949ba4]">这周没有 Issue</p>}
  </section>;
}
