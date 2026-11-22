const paths = {
  issues: "M7 4h11a2 2 0 0 1 2 2v11M4 8h10a2 2 0 0 1 2 2v9a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V9a1 1 0 0 1 1-1Z",
  table: "M3 5h18v14H3zM3 10h18M9 10v9",
  timeline: "M3 4v16h18M6 8h7M10 12h8M15 16h6",
  priority: "M4 18v-4m6 4V9m6 9V5",
  user: "M16 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 20a8 8 0 0 1 16 0",
  label: "m3 4 8 0 10 10-7 7L3 10zM7 7h.01",
  calendar: "M4 6h16v14H4zM8 3v5m8-5v5M4 11h16",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4",
  attach: "m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9",
  expand: "M14 4h6v6m0-6-7 7M4 14v6h6m-6 0 7-7",
  shrink: "M20 4l-7 7m0-6v6h6M4 20l7-7m0 6v-6H5",
  settings: "M3 7h6m5 0h7M3 17h11m5 0h2M9 4v6m6 4v6",
  send: "M12 19V5m-6 6 6-6 6 6",
  plus: "M12 5v14M5 12h14",
} as const;

export function IssueIcon({ name = "issues", size = 18 }: { name?: keyof typeof paths; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
