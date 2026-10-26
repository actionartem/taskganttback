// Federal five-day working week, checked 2026-10-26.
// https://www.cbr.ru/other/holidays/
// Decrees: 10.08.2023 #1314, 04.10.2024 #1335, 24.09.2025 #1466,
// 17.09.2026 #1187 (https://publication.pravo.gov.ru/document/0001202609180037).
const transfers = {
  2024: { off: ["04-29", "04-30", "05-10", "12-30", "12-31"], work: ["04-27", "11-02", "12-28"] },
  2025: { off: ["05-02", "05-08", "06-13", "11-03", "12-31"], work: ["11-01"] },
  2026: { off: ["01-09", "03-09", "05-11", "12-31"], work: [] },
  2027: { off: ["02-22", "05-03", "05-10", "06-14", "11-05", "12-31"], work: ["02-20"] },
};
const holidays = {
  "01-01": "Новогодние каникулы", "01-02": "Новогодние каникулы", "01-03": "Новогодние каникулы",
  "01-04": "Новогодние каникулы", "01-05": "Новогодние каникулы", "01-06": "Новогодние каникулы",
  "01-07": "Рождество Христово", "01-08": "Новогодние каникулы",
  "02-23": "День защитника Отечества", "03-08": "Международный женский день",
  "05-01": "Праздник Весны и Труда", "05-09": "День Победы", "06-12": "День России", "11-04": "День народного единства",
};
export function russianCalendarDay(ymd) {
  const year = Number(ymd.slice(0, 4)), md = ymd.slice(5, 10), rules = transfers[year];
  if (rules?.work.includes(md)) return { off: false, label: "Рабочая суббота · перенос", confirmed: true };
  const holiday = holidays[md];
  if (holiday) return { off: true, label: holiday, confirmed: !!rules };
  if (rules?.off.includes(md)) return { off: true, label: "Перенесённый выходной", confirmed: true };
  const weekday = new Date(ymd + "T00:00:00Z").getUTCDay();
  const off = weekday === 0 || weekday === 6;
  return { off, label: off ? "Выходной" : "Рабочий день", confirmed: !!rules };
}

const DAY = 86400000, OFFSET = 3 * 3600000;
// The owner defines an eight-hour day within 10:00-19:00 Moscow, without a fixed
// lunch interval. Partial windows are prorated by 8/9; these are elapsed workdays,
// not tracked labor hours.
export function workingMilliseconds(from, to) {
  if (from == null || to == null) return null;
  const start = new Date(from).getTime(), end = new Date(to).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  let sum = 0;
  for (let day = Math.floor((start + OFFSET) / DAY) * DAY - OFFSET; day < end; day += DAY) {
    const ymd = new Date(day + OFFSET).toISOString().slice(0,10);
    const calendar = russianCalendarDay(ymd);
    if (!calendar.confirmed) return null;
    if (!calendar.off) sum += Math.max(0, Math.min(end, day + 19 * 3600000) - Math.max(start, day + 10 * 3600000));
  }
  return Math.round(sum * 8 / 9);
}
