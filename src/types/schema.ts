import { z, ZodError } from "zod";
import { DateTime, Duration } from "luxon";
import {
    FREQUENCIES,
    specFromWeekdays,
    WEEKDAYS,
} from "../calendars/recurrence";
import { EventFrontmatter } from "../calendars/frontmatter";

const stripTime = (date: DateTime) => {
    // Strip time from luxon dateTime.
    return DateTime.fromObject(
        {
            year: date.year,
            month: date.month,
            day: date.day,
        },
        { zone: "utc" }
    );
};

export const ParsedDate = z.string();
// z.string().transform((val, ctx) => {
//     const parsed = DateTime.fromISO(val, { zone: "utc" });
//     if (parsed.invalidReason) {
//         ctx.addIssue({
//             code: z.ZodIssueCode.custom,
//             message: parsed.invalidReason,
//         });
//         return z.NEVER;
//     }
//     return stripTime(parsed);
// });

export const ParsedTime = z.string();
// z.string().transform((val, ctx) => {
//     let parsed = DateTime.fromFormat(val, "h:mm a");
//     if (parsed.invalidReason) {
//         parsed = DateTime.fromFormat(val, "HH:mm");
//     }

//     if (parsed.invalidReason) {
//         ctx.addIssue({
//             code: z.ZodIssueCode.custom,
//             message: parsed.invalidReason,
//         });
//         return z.NEVER;
//     }

//     return Duration.fromISOTime(
//         parsed.toISOTime({
//             includeOffset: false,
//             includePrefix: false,
//         })
//     );
// });

export const TimeSchema = z.discriminatedUnion("allDay", [
    z.object({ allDay: z.literal(true) }),
    z.object({
        allDay: z.literal(false),
        startTime: ParsedTime,
        endTime: ParsedTime.nullable().default(null),
    }),
]);

export const CommonSchema = z.object({
    title: z.string(),
    id: z.string().optional(),
});

/**
 * A recurrence rule as it is authored in frontmatter.
 *
 * Structural only: that `freq` and `rrule` are alternatives, that `count` and
 * `until` contradict each other, that a date is a real date — none of that is
 * checked here. `compileRecurrence` owns it, in one place, with error messages
 * that name the field and say what to do about it. Duplicating a subset of
 * those rules here would mean two answers to the question of what a valid rule
 * is.
 */
export const RecurrenceSchema = z.object({
    start: ParsedDate,
    freq: z.enum(FREQUENCIES).optional(),
    interval: z.number().optional(),
    byDay: z.array(z.enum(WEEKDAYS)).optional(),
    count: z.number().optional(),
    until: ParsedDate.optional(),
    rrule: z.string().optional(),
});

/**
 * A date an occurrence is skipped on.
 *
 * Quoting matters here in a way it does not elsewhere in the frontmatter: an
 * unquoted `20260326` is a number to YAML, not a date, so the schema rejects it
 * with a message that says so rather than letting a silently-unparseable value
 * through to the expander.
 */
const SkipDate = z.string({
    invalid_type_error:
        "skipDates must be ISO dates like 2026-03-26 — an unquoted 20260326 is a number to YAML, not a date.",
});

export const EventSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("single"),
        date: ParsedDate,
        endDate: ParsedDate.nullable().default(null),
        completed: ParsedDate.or(z.literal(false))
            .or(z.literal(null))
            .optional(),
    }),
    z.object({
        type: z.literal("recurring"),
        recurring: RecurrenceSchema,
        skipDates: z.array(SkipDate).optional(),
    }),
    z.object({
        type: z.literal("rrule"),
        startDate: ParsedDate,
        rrule: z.string(),
        skipDates: z.array(ParsedDate),
    }),
]);

type EventType = z.infer<typeof EventSchema>;
type TimeType = z.infer<typeof TimeSchema>;
type CommonType = z.infer<typeof CommonSchema>;

export type FerryEvent = CommonType & TimeType & EventType;

/**
 * Keys of the inherited recurrence shape, which is read and then replaced.
 *
 * Full Calendar, which this plugin forked from, described recurrence with these
 * three. They are still parsed, so a note written by the original plugin opens
 * and renders, but nothing writes them any more: `parseEvent` converts them to
 * a `recurring` block, and the write path removes them from the note once the
 * event is next saved. Exported for that removal.
 */
export const LEGACY_RECURRENCE_KEYS = [
    "daysOfWeek",
    "startRecur",
    "endRecur",
] as const;

/**
 * Settle which variant of the union a frontmatter object describes, converting
 * the inherited recurrence shape on the way.
 *
 * The discriminator is inferred rather than authored: §3.1's frontmatter has no
 * `type` key, and a key the user has to write correctly for their event to
 * appear at all is a key that will eventually be written wrong. Presence of
 * `recurring:` is what makes an event recurring.
 *
 * An authored block wins over the inherited keys if a note somehow carries
 * both, since it is the shape the plugin writes and therefore the newer of the
 * two.
 *
 * @throws If the inherited shape cannot be converted — a `daysOfWeek` that is
 * not a list, an unknown weekday code, or no start date. Such an event has no
 * well-defined set of occurrences, and rendering it from a guess would be worse
 * than not rendering it.
 */
function inferEventType(obj: Record<string, unknown>): Record<string, unknown> {
    const { daysOfWeek, startRecur, endRecur, ...rest } = obj;

    if (rest.recurring !== undefined) {
        return { ...rest, type: "recurring" };
    }

    if (daysOfWeek !== undefined) {
        if (!Array.isArray(daysOfWeek)) {
            throw new Error(
                `daysOfWeek must be a list of weekday codes like [T, R], got ${JSON.stringify(
                    daysOfWeek
                )}.`
            );
        }
        return {
            ...rest,
            type: "recurring",
            recurring: specFromWeekdays(
                daysOfWeek,
                startRecur as string | undefined,
                endRecur as string | undefined
            ),
        };
    }

    // An explicit `type` still wins — `rrule` events are built internally from
    // ICS and derived calendars, and there is nothing in their fields to infer
    // from.
    return { type: "single", ...rest };
}

export function parseEvent(obj: unknown): FerryEvent {
    if (typeof obj !== "object" || obj === null) {
        throw new Error("value for parsing was not an object.");
    }
    const objectWithDefaults = {
        allDay: false,
        ...inferEventType(obj as Record<string, unknown>),
    };
    return {
        ...CommonSchema.parse(objectWithDefaults),
        ...TimeSchema.parse(objectWithDefaults),
        ...EventSchema.parse(objectWithDefaults),
    };
}

export function validateEvent(obj: unknown): FerryEvent | null {
    try {
        return parseEvent(obj);
    } catch (e) {
        // Not only ZodErrors any more: converting the inherited recurrence
        // shape throws a plain Error, and a note that vanishes from the
        // calendar with nothing said about it is the hardest kind of bug to
        // report.
        console.debug("Parsing failed with errors", {
            obj,
            message: e instanceof Error ? e.message : String(e),
        });
        return null;
    }
}
/** Keys `parseEvent` derives rather than reads, and so never writes back. */
const INFERRED_KEYS = ["type"] as const;

/**
 * Keys a note should no longer carry once these fields have been written into
 * it.
 *
 * Everything the plugin infers or has replaced, minus whatever is actually
 * being written — an `rrule` event keeps its `type`, since nothing about its
 * fields would identify it on the way back in.
 *
 * Leaving them would not be untidiness but contradiction: a note whose event
 * has been changed from recurring to single, still carrying `type: recurring`,
 * describes an event with no rule and stops parsing altogether.
 *
 * @param fields Output of `serializeEvent`.
 * @returns Keys to hand to the writer for removal.
 */
export function replacedKeys(fields: EventFrontmatter): string[] {
    return [...INFERRED_KEYS, ...LEGACY_RECURRENCE_KEYS].filter(
        (key) => fields[key] === undefined
    );
}

/**
 * Turn an event into the fields to write into its note.
 *
 * The discriminator is dropped wherever `parseEvent` can infer it back, which
 * is every shape that reaches a note: a `type` key written but never read is
 * one more thing that can disagree with the event around it. `rrule` events are
 * the exception, since nothing about their fields identifies them, but they
 * exist only inside ICS and derived calendars and are never written to a file.
 */
export function serializeEvent(obj: FerryEvent): EventFrontmatter {
    const fields: Record<string, unknown> = { ...obj };
    if (obj.type !== "rrule") {
        delete fields.type;
    }
    return fields as EventFrontmatter;
}
