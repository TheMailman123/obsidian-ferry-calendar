import { DateTime } from "luxon";
import { RRule } from "rrule";

/**
 * Compilation of authored recurrence rules into RFC 5545 RRULE strings.
 *
 * Recurrence is authored in frontmatter as a structured block, because a rule
 * a user can read and edit by hand is worth more than one they have to look up:
 *
 * ```yaml
 * recurring:
 *   start: 2026-03-17
 *   freq: weekly
 *   interval: 1
 *   byDay: [TU, TH]
 *   count: 10
 * ```
 *
 * and compiled here to `FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH;COUNT=10`. The
 * structured block is what lives on disk and what round-trips; the compiled
 * string exists only long enough to be handed to the renderer. Nothing in this
 * module writes, and nothing parses a compiled string back into a spec —
 * compilation is one-way, exactly as slugging is in `filenames.ts`.
 *
 * The compiled string deliberately carries **no DTSTART**. The start date and
 * the event's start time live in separate frontmatter fields and are combined
 * by the caller, which is also where the timezone handling and FullCalendar's
 * DST workaround already live. Emitting DTSTART here would mean two places
 * deciding what time an occurrence starts.
 *
 * ## The timezone convention, which callers are bound by
 *
 * The `rrule` package is not timezone-aware in the way the name suggests: it
 * reads the **UTC components** of DTSTART as a wall-clock time, and the
 * occurrences it returns carry their answer in their UTC components too. A
 * DTSTART built from local midnight in Sydney is `13:00Z the previous day` as
 * far as the library is concerned, and every occurrence comes back shifted a
 * day to match.
 *
 * So there is one rule, and it is not optional:
 *
 * > Build DTSTART from UTC components, and read occurrences back as UTC.
 *
 * It binds this module too — `UNTIL` is rendered as the end of its day in UTC
 * for exactly this reason, since an endpoint measured in the local zone would
 * be compared against occurrences that were not, and would drop the last
 * occurrence of a series anywhere east of Greenwich.
 *
 * This module is free of Obsidian and DOM references so it can be unit-tested
 * directly.
 */

/** How often a series repeats. Lower-cased in frontmatter, upper-cased in RRULE. */
export const FREQUENCIES = ["daily", "weekly", "monthly", "yearly"] as const;

export type Frequency = (typeof FREQUENCIES)[number];

/**
 * Weekday codes, as RFC 5545 spells them.
 *
 * Note these are the two-letter iCalendar codes, *not* the single-letter
 * `UMTWRFS` codes the inherited `daysOfWeek` shape uses. The two are bridged in
 * one place only, `specFromWeekdays`.
 */
export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/**
 * A recurrence rule as authored in frontmatter.
 *
 * Either `freq` (the structured form) or `rrule` (the escape hatch) describes
 * the repetition; `start` is required by both, since a rule with no beginning
 * has no occurrences to generate.
 */
export interface RecurrenceSpec {
    /** DTSTART, as an ISO `YYYY-MM-DD` date. The day the series begins. */
    start: string;
    /** How often the series repeats. Required unless `rrule` is given. */
    freq?: Frequency;
    /** Repeat every N periods. Defaults to 1, and is omitted from the output when it is 1. */
    interval?: number;
    /** Days of the week the series falls on. */
    byDay?: Weekday[];
    /** Stop after this many occurrences. Mutually exclusive with `until`. */
    count?: number;
    /**
     * Stop after this date, **inclusive** — an occurrence falling on `until`
     * itself still happens. ISO `YYYY-MM-DD`.
     */
    until?: string;
    /**
     * Raw RRULE, for rules the structured form cannot express — `FREQ=MONTHLY;BYDAY=3FR`
     * and the like. When present it replaces the structured fields entirely.
     */
    rrule?: string;
}

/** Fields that describe the repetition itself, as opposed to when it starts. */
const STRUCTURED_RULE_FIELDS = ["freq", "interval", "byDay", "count"] as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Whether a value is a known frequency.
 *
 * Frontmatter is hand-authored, so a value being typed as a `Frequency`
 * upstream is no evidence that it is one.
 */
export function isFrequency(value: unknown): value is Frequency {
    return FREQUENCIES.includes(value as Frequency);
}

/** Whether a value is a known RFC 5545 weekday code. */
export function isWeekday(value: unknown): value is Weekday {
    return WEEKDAYS.includes(value as Weekday);
}

/**
 * Parse an ISO date, or throw naming the field that was wrong.
 *
 * @param value Date string, expected as `YYYY-MM-DD`.
 * @param field Frontmatter key the value came from, for the error message.
 */
function requireIsoDate(value: string, field: string): DateTime {
    if (!ISO_DATE.test(value.trim())) {
        throw new Error(
            `recurring.${field} must be an ISO date like 2026-03-17, got ${JSON.stringify(
                value
            )}.`
        );
    }
    const parsed = DateTime.fromISO(value.trim());
    if (!parsed.isValid) {
        throw new Error(
            `recurring.${field} is not a real date: ${JSON.stringify(value)}.`
        );
    }
    return parsed;
}

/**
 * Render `until` as the RRULE `UNTIL` value.
 *
 * `UNTIL` in RFC 5545 is a timestamp with an inclusive endpoint, but the
 * authored form is a plain date — "stop after the 30th" — so the whole of that
 * day has to fall inside the window, hence the end of the day rather than its
 * start.
 *
 * The end of the day *in UTC*, specifically — see the timezone convention in
 * this module's header for why, and for the matching obligation it places on
 * whoever builds DTSTART.
 */
function untilValue(until: string): string {
    const endOfDay = requireIsoDate(until, "until")
        .setZone("utc", { keepLocalTime: true })
        .endOf("day");
    return endOfDay.toFormat("yyyyMMdd'T'HHmmss'Z'");
}

/**
 * Validate a raw RRULE from the escape hatch and normalise its spelling.
 *
 * Accepts a bare rule (`FREQ=MONTHLY;BYDAY=3FR`) or one written with the
 * property name (`RRULE:FREQ=MONTHLY;BYDAY=3FR`), and returns the bare form.
 *
 * @throws If the rule does not parse, or parses to nothing recognisable. A rule
 * the plugin cannot read would otherwise render as an event that silently never
 * recurs.
 */
function normalizeRawRrule(raw: string): string {
    const bare = raw.trim().replace(/^RRULE:/i, "");
    if (bare === "") {
        throw new Error("recurring.rrule is empty.");
    }
    let options;
    try {
        options = RRule.parseString(bare);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(
            `recurring.rrule is not a valid RRULE (${message}): ${JSON.stringify(
                raw
            )}.`
        );
    }
    if (options.freq === undefined) {
        throw new Error(
            `recurring.rrule has no FREQ, so it describes no repetition: ${JSON.stringify(
                raw
            )}.`
        );
    }
    return bare;
}

/**
 * Check the spec is internally consistent before any of it is compiled.
 *
 * Every failure here is a rule that would otherwise generate the wrong
 * occurrences rather than none — the case worth being loud about, since a
 * calendar showing plausible-but-wrong dates is harder to notice than one
 * showing an error.
 */
function validateSpec(spec: RecurrenceSpec): void {
    const start = requireIsoDate(spec.start, "start");

    const structured = STRUCTURED_RULE_FIELDS.filter(
        (field) => spec[field] !== undefined
    );

    if (spec.rrule !== undefined) {
        // "The escape hatch wins when present" is only safe as a rule about
        // `start`, which both forms need. Letting it also override `freq` or
        // `byDay` would mean a rule the user wrote being silently discarded.
        if (structured.length > 0) {
            throw new Error(
                `recurring has both a raw rrule and structured ${structured.join(
                    ", "
                )}. Use one or the other — delete whichever is not meant to apply.`
            );
        }
    } else if (spec.freq === undefined) {
        throw new Error(
            "recurring needs either freq or rrule to describe how the event repeats."
        );
    } else if (!isFrequency(spec.freq)) {
        throw new Error(
            `recurring.freq must be one of ${FREQUENCIES.join(
                ", "
            )}, got ${JSON.stringify(spec.freq)}.`
        );
    }

    if (spec.count !== undefined && spec.until !== undefined) {
        throw new Error(
            "recurring has both count and until, which contradict each other. Keep one."
        );
    }

    if (spec.count !== undefined) {
        if (!Number.isInteger(spec.count) || spec.count < 1) {
            throw new Error(
                `recurring.count must be a whole number of occurrences, got ${JSON.stringify(
                    spec.count
                )}.`
            );
        }
    }

    if (spec.interval !== undefined) {
        if (!Number.isInteger(spec.interval) || spec.interval < 1) {
            throw new Error(
                `recurring.interval must be a whole number of periods, got ${JSON.stringify(
                    spec.interval
                )}.`
            );
        }
    }

    if (spec.byDay !== undefined) {
        if (!Array.isArray(spec.byDay) || spec.byDay.length === 0) {
            throw new Error(
                `recurring.byDay must be a non-empty list of weekdays like [TU, TH], got ${JSON.stringify(
                    spec.byDay
                )}.`
            );
        }
        const unknown = spec.byDay.filter((day) => !isWeekday(day));
        if (unknown.length > 0) {
            throw new Error(
                `recurring.byDay has unknown weekdays ${JSON.stringify(
                    unknown
                )}. Use the two-letter codes ${WEEKDAYS.join(", ")}.`
            );
        }
    }

    if (spec.until !== undefined) {
        const until = requireIsoDate(spec.until, "until");
        if (until < start.startOf("day")) {
            throw new Error(
                `recurring.until (${spec.until}) is before recurring.start (${spec.start}), so the series has no occurrences.`
            );
        }
    }
}

/**
 * Compile an authored recurrence block into an RFC 5545 RRULE string.
 *
 * @param spec Recurrence block from frontmatter.
 * @returns The rule, without a `DTSTART` and without the `RRULE:` prefix — the
 * form `rrulestr` takes alongside a separately-supplied `dtstart`.
 * @throws If the spec is unusable for any reason. Recurrence rules are the one
 * place in this plugin where a small mistake multiplies: a wrong rule is not one
 * wrong event but every occurrence of it, spread across a year of the calendar.
 * Refusing to compile is always better than compiling something plausible.
 */
export function compileRecurrence(spec: RecurrenceSpec): string {
    validateSpec(spec);

    if (spec.rrule !== undefined) {
        return normalizeRawRrule(spec.rrule);
    }

    // Non-null: validateSpec has established freq is a known frequency here.
    const parts = [`FREQ=${(spec.freq as Frequency).toUpperCase()}`];

    // An interval of 1 is the RFC default, so emitting it would only add noise
    // to a string the user may well end up reading in an error message.
    if (spec.interval !== undefined && spec.interval !== 1) {
        parts.push(`INTERVAL=${spec.interval}`);
    }
    if (spec.byDay !== undefined) {
        parts.push(`BYDAY=${spec.byDay.join(",")}`);
    }
    if (spec.count !== undefined) {
        parts.push(`COUNT=${spec.count}`);
    }
    if (spec.until !== undefined) {
        parts.push(`UNTIL=${untilValue(spec.until)}`);
    }

    return parts.join(";");
}

/** Inherited single-letter weekday codes, in the order the old shape lists them. */
const LEGACY_WEEKDAYS: Record<string, Weekday> = {
    U: "SU",
    M: "MO",
    T: "TU",
    W: "WE",
    R: "TH",
    F: "FR",
    S: "SA",
};

/**
 * Upgrade the inherited `daysOfWeek` recurrence shape to an authored spec.
 *
 * Full Calendar, which this plugin forked from, expressed recurrence as a set
 * of weekdays plus an optional window: `daysOfWeek: [T, R]` with `startRecur`
 * and `endRecur`. That is exactly a weekly rule with a `byDay`, so it converts
 * without loss and the plugin can render a note written by the original plugin.
 *
 * Read-side only. Nothing writes this shape any more, so an upgraded event is
 * stored back in the authored form the moment it is edited.
 *
 * @param daysOfWeek Single-letter codes, `U M T W R F S`.
 * @param startRecur First day of the series. Required — a series with no start
 * cannot be placed on a calendar, and the authored form makes DTSTART mandatory.
 * @param endRecur Last day of the series, if it is bounded. Inclusive, matching
 * `until`.
 * @throws If a weekday code is unrecognised, or there is no start date.
 */
export function specFromWeekdays(
    daysOfWeek: string[],
    startRecur: string | undefined,
    endRecur: string | undefined
): RecurrenceSpec {
    if (startRecur === undefined) {
        throw new Error(
            "A recurring event needs a start date. Add one to startRecur, or rewrite the event with a recurring block."
        );
    }
    const byDay = daysOfWeek.map((day) => {
        const weekday = LEGACY_WEEKDAYS[day];
        if (weekday === undefined) {
            throw new Error(
                `Unknown weekday code ${JSON.stringify(
                    day
                )} in daysOfWeek. Expected one of ${Object.keys(
                    LEGACY_WEEKDAYS
                ).join(", ")}.`
            );
        }
        return weekday;
    });
    return {
        start: startRecur,
        freq: "weekly",
        ...(byDay.length > 0 ? { byDay } : {}),
        ...(endRecur !== undefined ? { until: endRecur } : {}),
    };
}
