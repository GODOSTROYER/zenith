/**
 * Unix 5-field cron → EventBridge 6-field `cron(...)`.
 *
 * EventBridge differs from Unix cron in ways that silently change when a job
 * runs, so this translator is strict: anything it cannot translate faithfully
 * is REJECTED (`CronError`), never approximated.
 *
 *   Unix  `m h dom mon dow`            EventBridge `cron(m h dom mon dow year)`
 *   - day-of-week is 0-6 (SUN=0, 7=SUN); EventBridge is 1-7 (SUN=1). Converted.
 *   - exactly one of dom/dow must be `?`. A literal `*` in both becomes
 *     dom `*` / dow `?`; a restriction in one makes the other `?`.
 *   - Unix ORs dom and dow when both are restricted; EventBridge cannot
 *     express that, so both restricted is rejected.
 *   - `*` with a step (`*` slash 15) becomes `<min>/15` (EventBridge's increment
 *     form); `a-b` with a step is expanded to an explicit list; `n/s` without
 *     a range is not Unix and is rejected.
 *   - names (JAN, MON) are accepted and emitted as numbers.
 *   - `L`, `W`, `#`, `?`, a year, `@reboot` and AWS `rate(...)` are not Unix
 *     5-field cron and are rejected.
 *   - Rules fire in UTC; EventBridge rules have no time-zone setting.
 */

export class CronError extends Error {
  readonly code = "unsupported_schedule";
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const DAYS: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

const FIELDS: readonly FieldDef[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS },
  { name: "day-of-week", min: 0, max: 7, names: DAYS },
];

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

function num(text: string, def: FieldDef): number {
  const upper = text.toUpperCase();
  if (def.names && upper in def.names) return def.names[upper];
  if (!/^\d{1,2}$/.test(text)) throw new CronError(`${def.name}: "${text}" is not a number${def.names ? " or name" : ""}.`);
  const n = Number(text);
  if (n < def.min || n > def.max) throw new CronError(`${def.name}: ${n} is outside ${def.min}-${def.max}.`);
  return n;
}

/** Every value a field matches, ascending, plus whether it was a bare `*`. */
function expand(text: string, def: FieldDef): { values: number[]; star: boolean } {
  if (text === "*" || text === "*/1") return { values: range(def.min, def.name === "day-of-week" ? 6 : def.max, 1), star: true };
  const out = new Set<number>();
  for (const term of text.split(",")) {
    if (term === "") throw new CronError(`${def.name}: empty list item.`);
    const [body, stepText, extra] = term.split("/");
    if (extra !== undefined) throw new CronError(`${def.name}: "${term}" has more than one step.`);
    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = def.min;
      hi = def.name === "day-of-week" ? 6 : def.max;
    } else if (body.includes("-")) {
      const [a, b, more] = body.split("-");
      if (more !== undefined || a === "" || b === undefined || b === "") throw new CronError(`${def.name}: malformed range "${body}".`);
      lo = num(a, def);
      hi = num(b, def);
      if (lo > hi) throw new CronError(`${def.name}: range ${body} wraps around; split it into two ranges.`);
    } else {
      if (stepText !== undefined) throw new CronError(`${def.name}: "${term}" (a value with a step and no range) is not Unix cron syntax.`);
      lo = hi = num(body, def);
    }
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText) || Number(stepText) < 1 || Number(stepText) > def.max) throw new CronError(`${def.name}: invalid step "${stepText}".`);
      step = Number(stepText);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return { values: [...out].sort((a, b) => a - b), star: false };
}

const range = (lo: number, hi: number, step: number): number[] => {
  const out: number[] = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
};

/** `1,2,3,5` → `1-3,5`. */
function compress(values: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < values.length; ) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j += 1;
    parts.push(j - i >= 2 ? `${values[i]}-${values[j]}` : values.slice(i, j + 1).join(","));
    i = j + 1;
  }
  return parts.join(",");
}

/** Text for a non-day field, keeping `*`, `a-b`, lists and the `<min>/<step>` increment readable. */
function simpleText(text: string, def: FieldDef, values: readonly number[]): string {
  if (text === "*" || text === "*/1") return "*";
  const star = /^\*\/(\d+)$/.exec(text);
  if (star) return `${def.min}/${Number(star[1])}`;
  return compress(values);
}

export interface AwsSchedule {
  /** `cron(0 2 ? * 2-6 *)` */
  expression: string;
  /** the normalized 5-field form it came from, for the rule description */
  source: string;
}

/** Translate a manifest schedule, or throw `CronError` saying what is unsupported. */
export function toEventBridgeCron(input: string): AwsSchedule {
  if (typeof input !== "string") throw new CronError("schedule must be a string.");
  let text = input.trim().replace(/\s+/g, " ");
  if (text.length === 0 || text.length > 100) throw new CronError("schedule must be 1-100 characters.");
  if (text.startsWith("@")) {
    const alias = ALIASES[text.toLowerCase()];
    if (!alias) throw new CronError(`${text} has no scheduled equivalent (only @hourly, @daily, @weekly, @monthly, @yearly).`);
    text = alias;
  }
  if (/^(cron|rate|at)\(/i.test(text)) throw new CronError("give a 5-field cron expression (minute hour day-of-month month day-of-week), not an EventBridge expression.");
  if (!/^[0-9A-Za-z*/,\- ]+$/.test(text)) throw new CronError("schedule contains characters that are not part of 5-field cron (L, W, #, ? are EventBridge-only).");
  const fields = text.split(" ");
  if (fields.length !== 5) throw new CronError(`expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}.`);

  const [minuteText, hourText, domText, monthText, dowText] = fields;
  const minute = expand(minuteText, FIELDS[0]);
  const hour = expand(hourText, FIELDS[1]);
  const dom = expand(domText, FIELDS[2]);
  const month = expand(monthText, FIELDS[3]);
  const dow = expand(dowText, FIELDS[4]);

  if (!dom.star && !dow.star) {
    throw new CronError("both day-of-month and day-of-week are restricted; cron would run on either, EventBridge cannot express that. Restrict only one of them.");
  }

  // Unix day-of-week 0-7 (7 = Sunday) → the set 0-6, then EventBridge 1-7 (SUN = 1).
  const dowUnix = [...new Set(dow.values.map((v) => (v === 7 ? 0 : v)))].sort((a, b) => a - b);
  const dowAws = dowUnix.map((v) => v + 1);

  const fMinute = simpleText(minuteText, FIELDS[0], minute.values);
  const fHour = simpleText(hourText, FIELDS[1], hour.values);
  const fMonth = simpleText(monthText, FIELDS[3], month.values);
  const fDom = dom.star ? (dow.star ? "*" : "?") : simpleText(domText, FIELDS[2], dom.values);
  const fDow = dow.star ? "?" : compress(dowAws);

  return { expression: `cron(${fMinute} ${fHour} ${fDom} ${fMonth} ${fDow} *)`, source: text };
}
