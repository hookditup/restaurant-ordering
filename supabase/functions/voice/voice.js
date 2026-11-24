// Pure helpers for the AI phone host: spoken dates and times, and which open times to offer.

const WEEK = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Today's date (YYYY-MM-DD) in a time zone. */
export const localDay = (tz, now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

/**
 * A spoken day ("tonight", "tomorrow", "Friday", "next Friday", "November 28th", "11/28", "2026-11-28", "the 28th")
 * as YYYY-MM-DD in the restaurant's time zone, never in the past. null when it can't tell.
 */
export function parseDay(text, tz, now = new Date()) {
  const s = String(text ?? '').toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const today = localDay(tz, now), [ty, tm] = today.split('-').map(Number);
  if (/\b(today|tonight|this evening)\b/.test(s)) return today;
  if (/\bday after tomorrow\b/.test(s)) return addDays(today, 2);
  if (/\btomorrow\b/.test(s)) return addDays(today, 1);
  let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}` >= today ? `${m[1]}-${m[2]}-${m[3]}` : null;
  const ymd = (mo, d) => {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    let y = ty;
    const pad = (n) => String(n).padStart(2, '0');
    if (`${y}-${pad(mo)}-${pad(d)}` < today) y++;
    const out = `${y}-${pad(mo)}-${pad(d)}`;
    return new Date(`${out}T12:00:00Z`).toISOString().slice(0, 10) === out ? out : null; // no Feb 30
  };
  m = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/);
  if (m) return ymd(+m[1], +m[2]);
  m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/) || s.match(/\b(\d{1,2})\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
  if (m) return /^\d/.test(m[1]) ? ymd(MONTHS.indexOf(m[2]) + 1, +m[1]) : ymd(MONTHS.indexOf(m[1]) + 1, +m[2]);
  const wd = WEEK.findIndex((w) => new RegExp(`\\b${w}\\b`).test(s));
  if (wd >= 0) {
    let n = (wd - dow(today) + 7) % 7;
    if (n === 0 && /\bnext\b/.test(s)) n = 7; // "next Friday" said on a Friday
    return addDays(today, n);
  }
  m = s.match(/\bthe (\d{1,2})\b/);
  if (m) { const d = +m[1]; return d >= +today.slice(8) ? ymd(tm, d) : ymd(tm === 12 ? 1 : tm + 1, d); }
  return null;
}

/** A spoken time ("6:30", "6 pm", "noon", "7:15 in the evening") as minutes after midnight. Bare 1-9 means evening. */
export function parseClock(text) {
  const s = String(text ?? '').toLowerCase().trim();
  if (!s) return null;
  if (/\bnoon\b/.test(s)) return 12 * 60;
  const t = s.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?/);
  if (!t) return null;
  let h = +t[1]; const min = +(t[2] ?? 0), mer = (t[3] ?? '').replace(/[^ap]/g, '');
  if (h > 23 || min > 59) return null;
  if (mer === 'p' && h < 12) h += 12;
  else if (mer === 'a' && h === 12) h = 0;
  else if (!mer && /evening|night|dinner/.test(s) && h < 12) h += 12;
  else if (!mer && h >= 1 && h <= 9) h += 12;
  return h * 60 + min;
}

/** Up to n open times (from res_day slots) closest to the wanted minute, in time order. */
export function nearestOpen(slots, wanted, guests, maxOnline, n = 3) {
  const fits = slots.filter((s) => guests > maxOnline || s.left >= guests);
  const ranked = wanted == null ? fits : [...fits].sort((a, b) => Math.abs(a.min - wanted) - Math.abs(b.min - wanted));
  return ranked.slice(0, n).sort((a, b) => a.min - b.min);
}

/** "Friday, November 28" */
export const dayText = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
/** "6, 6:30 or 7 PM"-style list of labels like "6:00 PM". */
export const listTimes = (labels) => (labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`);
