import { DateTime } from "luxon";
import { z } from "zod";
import { FerryEvent } from "../../types";

/*
 * Mapping arbitrary note frontmatter onto calendar events.
 *
 * A derived calendar renders notes that exist for their own reasons — a record
 * that happens to carry dates — so the note author owns the format and the
 * mapping adapts to it. Everything here is data-driven from a DerivedMapping:
 * nothing in this file knows what any particular folder of notes is *about*.
 *
 * This module is deliberately free of Obsidian and DOM references so it can be
 * tested directly under jest's node environment.
 */

/** How a note is excluded from a derived calendar without deleting it. */
export const derivedFilterSchema = z.object({
    // A filter on no property at all would silently exclude every note, which
    // looks exactly like a mapping that matches nothing.
    property: z.string().min(1),
    op: z.enum(["exists", "missing", "equals", "notEquals"]),
    /** Required by `equals`/`notEquals`, ignored by the others. */
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export type DerivedFilter = z.infer<typeof derivedFilterSchema>;

export const derivedMappingSchema = z.object({
    /** Title template. See `renderTitle` for the supported placeholders. */
    title: z.string().default("{{file.basename}}"),
    /** Property holding the start date, optionally carrying a time. */
    start: z.string().min(1),
    /** Property holding the end date. Absent means a single day. */
    end: z.string().optional(),
    /** Property holding the start time, when it is separate from the date. */
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    /** `true`/`false` outright, or the name of a property to read it from. */
    allDay: z.union([z.boolean(), z.string()]).default(true),
    /** "none", "yearly", "monthly", or a raw RFC 5545 RRULE string. */
    repeat: z.string().default("none"),
    /** "iso", or a luxon format string for non-ISO sources. */
    dateFormat: z.string().default("iso"),
    /** Whether a note with no start date is skipped quietly or reported. */
    skipIfMissing: z.boolean().default(true),
    filter: derivedFilterSchema.optional(),
});

export type DerivedMapping = z.infer<typeof derivedMappingSchema>;

/**
 * A mapping with every default filled in and no start property chosen yet.
 *
 * Built by parsing so the defaults cannot drift from the schema's; the start
 * property is blanked afterwards because the schema requires one and this is
 * the state a settings form begins in, before the user has picked anything.
 */
export const emptyDerivedMapping = (): DerivedMapping => ({
    ...derivedMappingSchema.parse({ start: "unset" }),
    start: "",
});

/** The note fields a mapping can draw on, independent of Obsidian's TFile. */
export type NoteRef = {
    basename: string;
    path: string;
};

/**
 * What a mapping made of one note.
 *
 * The three non-event outcomes are kept distinct because they mean different
 * things to the person writing the mapping: "filtered" is working as intended,
 * "skipped" is an expected gap in the data, and "error" means the mapping and
 * the notes disagree and one of them needs fixing. Collapsing them would turn
 * a broken mapping into a silently short calendar.
 */
export type MappingOutcome =
    | { status: "event"; event: FerryEvent }
    | { status: "filtered"; reason: string }
    | { status: "skipped"; reason: string }
    | { status: "error"; reason: string };

/**
 * Whether a frontmatter value counts as "not there".
 *
 * `BIRTHDAY:` with nothing after it parses to `null`, not `undefined`, and a
 * quoted empty string is no more of a date than either. All three have to count
 * as absent: treating only `undefined` that way is what produced ghost events
 * dated 2000-01-01 in the dataviewjs prototype, since `null` sailed through to
 * the date parser and came out as the epoch.
 */
export function isAbsent(value: unknown): boolean {
    return (
        value === undefined ||
        value === null ||
        (typeof value === "string" && value.trim() === "")
    );
}

type Frontmatter = Record<string, unknown> | undefined;

function lookup(frontmatter: Frontmatter, property: string): unknown {
    if (!frontmatter) {
        return undefined;
    }
    return frontmatter[property];
}

/**
 * Apply a mapping's filter predicate.
 *
 * The predicate is declarative rather than an expression to evaluate: mappings
 * are loaded from data.json, and a config file should not be able to run code.
 *
 * @returns null when the note passes, or the reason it was excluded.
 */
export function applyFilter(
    frontmatter: Frontmatter,
    filter: DerivedFilter
): string | null {
    const value = lookup(frontmatter, filter.property);
    const absent = isAbsent(value);
    switch (filter.op) {
        case "exists":
            return absent ? `'${filter.property}' is not set` : null;
        case "missing":
            return absent ? null : `'${filter.property}' is set`;
        case "equals":
            return value === filter.value
                ? null
                : `'${filter.property}' is not ${JSON.stringify(filter.value)}`;
        case "notEquals":
            return value === filter.value
                ? `'${filter.property}' is ${JSON.stringify(filter.value)}`
                : null;
    }
    // Exhaustiveness guard: a new operator must decide how it excludes a note.
    const unreachable: never = filter.op;
    throw new Error(`Unknown derived-calendar filter op '${unreachable}'.`);
}

/** A date, plus the time of day if the source value carried one. */
type ParsedDateValue = { date: string; time: string | null };

const ISO_TIME_PATTERN = /\d{1,2}:\d{2}/;

/**
 * Parse one frontmatter value into a date and an optional time.
 *
 * Everything is parsed in UTC on purpose. A YAML date-only value reaches us as
 * a `Date` at UTC midnight, and reading it back in a negative-offset zone would
 * report the previous day — the off-by-one that makes an all-day event show up
 * on the wrong date for half the world.
 */
export function parseDateValue(
    value: unknown,
    dateFormat: string
): ParsedDateValue | { error: string } {
    if (value instanceof Date) {
        const parsed = DateTime.fromJSDate(value, { zone: "utc" });
        if (!parsed.isValid) {
            return { error: `not a valid date (${parsed.invalidReason})` };
        }
        // A date-only YAML value lands on exact midnight, so a zero time is
        // taken to mean "no time given" rather than "midnight".
        const hasTime =
            parsed.hour !== 0 || parsed.minute !== 0 || parsed.second !== 0;
        return {
            date: parsed.toISODate(),
            time: hasTime ? parsed.toFormat("HH:mm") : null,
        };
    }

    if (typeof value !== "string") {
        // Numbers are the interesting case: 2019 could be a year and 1560000000
        // could be a timestamp, and guessing wrong yields a plausible-looking
        // wrong date rather than an obvious failure.
        return {
            error: `expected a date string but found ${typeof value}`,
        };
    }

    const raw = value.trim();

    if (dateFormat !== "iso") {
        const parsed = DateTime.fromFormat(raw, dateFormat, { zone: "utc" });
        if (!parsed.isValid) {
            return {
                error: `'${raw}' does not match the format '${dateFormat}' (${parsed.invalidReason})`,
            };
        }
        // Whether a custom format carries a time is a property of the format,
        // not of the value it parsed.
        const hasTime = /[hHm]/.test(dateFormat);
        return {
            date: parsed.toISODate(),
            time: hasTime ? parsed.toFormat("HH:mm") : null,
        };
    }

    // "2020-05-04 09:30" is a date-time to everyone except the ISO parser.
    const isoish = raw.replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
    const parsed = DateTime.fromISO(isoish, { zone: "utc" });
    if (!parsed.isValid) {
        return {
            error: `'${raw}' is not an ISO date (${parsed.invalidReason})`,
        };
    }
    return {
        date: parsed.toISODate(),
        time: ISO_TIME_PATTERN.test(isoish) ? parsed.toFormat("HH:mm") : null,
    };
}

/**
 * Read a time-of-day property, e.g. "9:30", "09:30", "9:30 AM".
 */
function parseTimeValue(value: unknown): string | { error: string } {
    if (value instanceof Date) {
        return DateTime.fromJSDate(value, { zone: "utc" }).toFormat("HH:mm");
    }
    if (typeof value !== "string") {
        return { error: `expected a time string but found ${typeof value}` };
    }
    const raw = value.trim();
    for (const format of ["H:mm", "H:mm:ss", "h:mm a", "h a"]) {
        const parsed = DateTime.fromFormat(raw, format, { zone: "utc" });
        if (parsed.isValid) {
            return parsed.toFormat("HH:mm");
        }
    }
    return { error: `'${raw}' is not a recognisable time` };
}

/**
 * Resolve the mapping's `allDay` setting for one note.
 *
 * @returns the resolved flag, `null` when a named property is absent and the
 *          caller should fall back to whether a time was found, or an error.
 */
function resolveAllDay(
    frontmatter: Frontmatter,
    allDay: boolean | string
): boolean | null | { error: string } {
    if (typeof allDay === "boolean") {
        return allDay;
    }
    const value = lookup(frontmatter, allDay);
    if (isAbsent(value)) {
        return null;
    }
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true") {
            return true;
        }
        if (normalized === "false") {
            return false;
        }
    }
    return {
        error: `'${allDay}' is ${JSON.stringify(
            value
        )}, which is not true or false`,
    };
}

const PLACEHOLDER_PATTERN = /\{\{([^}]*)\}\}/g;

/**
 * Render a title template against a note.
 *
 * Supports `{{file.basename}}`, `{{file.path}}` and `{{property:NAME}}`.
 *
 * `{{age}}` from the design doc is deliberately *not* supported yet, and is
 * rejected rather than rendered as something misleading. A projected repeat is
 * emitted as a single recurring event with one title, so an age would show the
 * same number on every occurrence — visibly wrong the moment you page back a
 * year. Supporting it properly needs the windowed per-occurrence expansion that
 * the recurrence engine introduces.
 *
 * @returns the rendered title, or the reason it could not be rendered.
 */
export function renderTitle(
    template: string,
    frontmatter: Frontmatter,
    file: NoteRef
): string | { error: string } {
    let failure: string | null = null;

    const rendered = template.replace(PLACEHOLDER_PATTERN, (_match, token) => {
        const key = String(token).trim();

        if (key === "file.basename") {
            return file.basename;
        }
        if (key === "file.path") {
            return file.path;
        }
        if (key.startsWith("property:")) {
            const property = key.slice("property:".length).trim();
            const value = lookup(frontmatter, property);
            if (isAbsent(value)) {
                failure ??= `title needs property '${property}', which is not set`;
                return "";
            }
            return String(value);
        }
        if (key === "age") {
            failure ??=
                "'{{age}}' is not supported yet: a projected repeat renders one title for the whole series, so an age would be wrong on every occurrence but one";
            return "";
        }
        failure ??= `unknown title placeholder '{{${key}}}'`;
        return "";
    });

    if (failure !== null) {
        return { error: failure };
    }
    if (rendered.trim() === "") {
        return { error: `title template '${template}' rendered empty` };
    }
    return rendered;
}

/**
 * Turn "none" | "yearly" | "monthly" | a raw RRULE into an RRULE string.
 *
 * @returns null for no repeat, the RRULE string otherwise.
 */
function resolveRepeat(repeat: string): string | null | { error: string } {
    const normalized = repeat.trim();
    switch (normalized.toLowerCase()) {
        case "":
        case "none":
            return null;
        case "yearly":
            return "FREQ=YEARLY";
        case "monthly":
            return "FREQ=MONTHLY";
    }
    // Anything else is taken as a raw rule. Requiring it to look like one keeps
    // a typo'd keyword ("yearl") from being handed to the RRULE parser as if it
    // were deliberate.
    if (/FREQ=/i.test(normalized)) {
        return normalized;
    }
    return {
        error: `repeat '${repeat}' is not none/yearly/monthly and does not look like an RRULE`,
    };
}

const hasError = (v: unknown): v is { error: string } =>
    typeof v === "object" && v !== null && "error" in v;

/**
 * Project one note onto a calendar event.
 *
 * The mapping decides everything: which properties hold the dates, how the
 * title is built, whether the note repeats. Notes that the mapping cannot
 * describe are reported rather than dropped, because a silent gap across a
 * folder of a hundred notes is undebuggable.
 *
 * @param frontmatter the note's frontmatter, or undefined when it has none
 * @param file the note being mapped
 * @param mapping the calendar's mapping configuration
 */
export function mapNoteToEvent(
    frontmatter: Frontmatter,
    file: NoteRef,
    mapping: DerivedMapping
): MappingOutcome {
    if (mapping.filter) {
        const excluded = applyFilter(frontmatter, mapping.filter);
        if (excluded !== null) {
            return { status: "filtered", reason: excluded };
        }
    }

    const startValue = lookup(frontmatter, mapping.start);
    if (isAbsent(startValue)) {
        const reason = `'${mapping.start}' is not set`;
        // skipIfMissing off is a claim that every note in the folder has a
        // start date, so a note without one means the mapping is wrong.
        return mapping.skipIfMissing
            ? { status: "skipped", reason }
            : { status: "error", reason };
    }

    const start = parseDateValue(startValue, mapping.dateFormat);
    if (hasError(start)) {
        return {
            status: "error",
            reason: `'${mapping.start}': ${start.error}`,
        };
    }

    let end: ParsedDateValue | null = null;
    if (mapping.end) {
        const endValue = lookup(frontmatter, mapping.end);
        if (!isAbsent(endValue)) {
            const parsed = parseDateValue(endValue, mapping.dateFormat);
            if (hasError(parsed)) {
                return {
                    status: "error",
                    reason: `'${mapping.end}': ${parsed.error}`,
                };
            }
            if (parsed.date < start.date) {
                return {
                    status: "error",
                    reason: `'${mapping.end}' (${parsed.date}) is before '${mapping.start}' (${start.date})`,
                };
            }
            end = parsed;
        }
    }

    // An explicit time property wins over a time carried by the date value.
    let startTime: string | null = start.time;
    if (mapping.startTime) {
        const value = lookup(frontmatter, mapping.startTime);
        if (!isAbsent(value)) {
            const parsed = parseTimeValue(value);
            if (hasError(parsed)) {
                return {
                    status: "error",
                    reason: `'${mapping.startTime}': ${parsed.error}`,
                };
            }
            startTime = parsed;
        }
    }

    let endTime: string | null = end?.time ?? null;
    if (mapping.endTime) {
        const value = lookup(frontmatter, mapping.endTime);
        if (!isAbsent(value)) {
            const parsed = parseTimeValue(value);
            if (hasError(parsed)) {
                return {
                    status: "error",
                    reason: `'${mapping.endTime}': ${parsed.error}`,
                };
            }
            endTime = parsed;
        }
    }

    const resolvedAllDay = resolveAllDay(frontmatter, mapping.allDay);
    if (hasError(resolvedAllDay)) {
        return { status: "error", reason: resolvedAllDay.error };
    }
    // A named allDay property that the note doesn't set falls back to whether a
    // time was found anywhere, which is the same conclusion a reader would draw.
    const allDay = resolvedAllDay ?? startTime === null;

    if (!allDay && startTime === null) {
        return {
            status: "error",
            reason: `mapped as a timed event but no start time was found in '${
                mapping.start
            }'${mapping.startTime ? ` or '${mapping.startTime}'` : ""}`,
        };
    }

    const title = renderTitle(mapping.title, frontmatter, file);
    if (hasError(title)) {
        return { status: "error", reason: title.error };
    }

    const repeat = resolveRepeat(mapping.repeat);
    if (hasError(repeat)) {
        return { status: "error", reason: repeat.error };
    }

    const time = allDay
        ? ({ allDay: true } as const)
        : ({
              allDay: false,
              startTime: startTime as string,
              endTime,
          } as const);

    if (repeat !== null) {
        if (end && end.date !== start.date) {
            return {
                status: "error",
                reason: `a repeating projection cannot span multiple days, but '${mapping.end}' puts this one on ${start.date}–${end.date}`,
            };
        }
        return {
            status: "event",
            event: {
                title,
                ...time,
                type: "rrule",
                startDate: start.date,
                rrule: repeat,
                // A projection has nothing to override: the source note is the
                // only record, and the plugin never writes exceptions to it.
                skipDates: [],
            },
        };
    }

    return {
        status: "event",
        event: {
            title,
            ...time,
            type: "single",
            date: start.date,
            endDate: end ? endDateFor(end.date, start.date, allDay) : null,
        },
    };
}

/**
 * Convert an end date from the note's terms into the calendar's.
 *
 * A note that records `end: 2019-06-10` means the last day *is* the 10th, while
 * an all-day event's end is exclusive, so the calendar needs the 11th. Getting
 * this wrong drops the final day of every multi-day record — quiet, and wrong
 * on exactly the notes people look at most. Timed events end at a time on the
 * day given, so they pass through untouched.
 *
 * @returns the end date to store, or null when it adds nothing to the start
 */
function endDateFor(
    end: string,
    start: string,
    allDay: boolean
): string | null {
    if (!allDay) {
        return end === start ? null : end;
    }
    if (end === start) {
        // A single all-day date needs no end at all.
        return null;
    }
    return DateTime.fromISO(end, { zone: "utc" }).plus({ days: 1 }).toISODate();
}

/** Counts and samples from mapping a whole folder, for reporting to the user. */
export type MappingReport = {
    matched: number;
    filtered: number;
    skipped: number;
    errors: number;
    /** Up to `sampleLimit` examples of each non-matched outcome. */
    samples: {
        matched: { path: string; title: string }[];
        skipped: { path: string; reason: string }[];
        errors: { path: string; reason: string }[];
    };
};

/**
 * Summarise a folder's worth of outcomes.
 *
 * This is what makes a generic mapper usable rather than a guessing game: the
 * settings preview and the load-time log both need "N matched, M skipped, and
 * here is why", and neither should have to re-derive it.
 *
 * @param outcomes one per note, paired with the note's path
 * @param sampleLimit how many examples of each kind to keep
 */
export function summarizeOutcomes(
    outcomes: { path: string; outcome: MappingOutcome }[],
    sampleLimit = 3
): MappingReport {
    const report: MappingReport = {
        matched: 0,
        filtered: 0,
        skipped: 0,
        errors: 0,
        samples: { matched: [], skipped: [], errors: [] },
    };

    for (const { path, outcome } of outcomes) {
        switch (outcome.status) {
            case "event":
                report.matched++;
                if (report.samples.matched.length < sampleLimit) {
                    report.samples.matched.push({
                        path,
                        title: outcome.event.title,
                    });
                }
                break;
            case "filtered":
                report.filtered++;
                break;
            case "skipped":
                report.skipped++;
                if (report.samples.skipped.length < sampleLimit) {
                    report.samples.skipped.push({
                        path,
                        reason: outcome.reason,
                    });
                }
                break;
            case "error":
                report.errors++;
                if (report.samples.errors.length < sampleLimit) {
                    report.samples.errors.push({
                        path,
                        reason: outcome.reason,
                    });
                }
                break;
        }
    }

    return report;
}
