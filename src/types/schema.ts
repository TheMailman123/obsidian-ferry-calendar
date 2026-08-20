import { z, ZodError } from "zod";
import { DateTime, Duration } from "luxon";
import {
    FREQUENCIES,
    specFromWeekdays,
    WEEKDAYS,
} from "../calendars/recurrence";
import { EventFrontmatter } from "../calendars/frontmatter";
import { wikilinkFromYaml } from "../calendars/links";

/**
 * A wikilink field, tolerant of the shape an unquoted one used to be read as.
 *
 * See `wikilinkFromYaml`: the plugin wrote `[[link]]` into YAML unquoted, which
 * reads back as a nested sequence rather than a string. Notes written that way
 * are still in vaults, so the shape is accepted and normalised here rather than
 * migrated. Anything else falls through to `z.string()` and is rejected with
 * the ordinary message.
 */
const WikilinkSchema = z.preprocess(
    (value) => wikilinkFromYaml(value) ?? value,
    z.string()
);

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
    /**
     * Identity for the ICS export, stable for the life of the event.
     *
     * Written into the note the first time a calendar with export enabled is
     * exported, and never changed after — that is the whole of its job. The
     * cache's `id` cannot serve: it is generated per session, so every export
     * would present a new set of events and a subscriber would delete and
     * recreate the calendar rather than update it. Nor can the path, since this
     * plugin renames notes whenever a date or title changes, which is exactly
     * when an update matters most. See PLANNING §7.4.
     *
     * Absent on every event until it is exported, and absent forever on
     * calendars that are never exported: a key in someone's notes has to earn
     * its place.
     */
    uid: z.string().optional(),
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
        /**
         * The last day the event covers, **inclusive** — `2026-03-19` on a trip
         * means the trip runs through the 19th. Everything that renders,
         * selects or exports it wants an exclusive boundary instead; the shift
         * belongs to `calendars/end_date.ts` and to nothing else.
         */
        endDate: ParsedDate.nullable().default(null),
        completed: ParsedDate.or(z.literal(false))
            .or(z.literal(null))
            .optional(),
        /**
         * The occurrence this note replaces, as the date the rule would have
         * generated it on — *not* the date the note now falls on, which is
         * `date` and may well differ.
         */
        recurrenceId: ParsedDate.optional(),
        /** Wikilink to the master whose occurrence this replaces. */
        recurringParent: WikilinkSchema.optional(),
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
 * The two fields that together make a single event an override.
 *
 * Listed for removal as well as for writing: an override edited back into an
 * ordinary event has to stop claiming to replace an occurrence, or the master
 * would go on suppressing a date nothing replaces any more.
 */
export const OVERRIDE_KEYS = ["recurrenceId", "recurringParent"] as const;

/**
 * An override: the single event that stands in for one occurrence of a series.
 *
 * Deliberately *not* a fourth variant of the union. An override renders, is
 * filed, is named and is completed exactly as any other one-date event, so it
 * is one — with two extra fields saying which occurrence it displaces. Making
 * it its own variant would fork all of that behaviour and leave every
 * `type === "single"` check in the plugin silently not applying to it, which
 * fails by rendering nothing rather than by saying anything.
 *
 * What that costs is the union's guarantee that the two fields travel together,
 * so `parseEvent` enforces it directly instead — see `requirePairedOverride`.
 */
export type OverrideFields = {
    recurrenceId: string;
    recurringParent: string;
};

/**
 * Whether an event replaces one occurrence of a recurring series.
 *
 * The one place the question is asked, so that "is this an override" has a
 * single answer rather than a `recurrenceId !== undefined` check repeated at
 * each call site with slightly different edges.
 */
export function isOverride(
    event: FerryEvent
): event is FerryEvent & OverrideFields {
    return event.type === "single" && event.recurrenceId !== undefined;
}

/**
 * Fields a stored event carries that no editing surface can express.
 *
 * A drag knows where it dropped something; a form knows what is in its inputs.
 * Neither knows that the note it is editing stands in for one occurrence of a
 * series, or what identity the ICS export gave it — so both used to rebuild the
 * event from what they *did* know and silently drop the rest.
 *
 * For an override that was fatal rather than untidy. Dropping the pair does not
 * merely lose two keys: `replacedKeys` then lists them as obsolete and the write
 * path **removes them from the note**, so nudging a moved occurrence by five
 * minutes detached it from its series permanently and the master started drawing
 * the occurrence again. See PLANNING §13.2.
 *
 * `id` is deliberately not carried. It is a cache-level identifier that this
 * plugin does not write into a working-calendar note, and carrying it would
 * start adding an `id:` key to notes that have never had one. `uid` is the
 * opposite case — deliberately persisted, and stable for the life of the event,
 * so losing it would make the next export look like a fresh set of events.
 *
 * @param existing The event as it is stored, or null when there is none —
 * creating rather than editing, and there is nothing to carry.
 * @param into The variant the edit produces. The override pair travels only
 * onto a single event: a series cannot stand in for one occurrence of another,
 * and writing the keys onto a recurring note would leave it claiming to.
 */
export function carryOverFields(
    existing: Partial<FerryEvent> | null | undefined,
    into: FerryEvent["type"]
): CarriedFields {
    if (!existing) {
        return {};
    }
    const carried: CarriedFields = {};
    if (existing.uid !== undefined) {
        carried.uid = existing.uid;
    }
    if (
        into === "single" &&
        existing.type === "single" &&
        existing.recurrenceId !== undefined &&
        existing.recurringParent !== undefined
    ) {
        carried.recurrenceId = existing.recurrenceId;
        carried.recurringParent = existing.recurringParent;
    }
    return carried;
}

/** @see carryOverFields */
export type CarriedFields = {
    uid?: string;
    recurrenceId?: string;
    recurringParent?: string;
};

/**
 * Reject half an override.
 *
 * `recurrenceId` says which occurrence is replaced and `recurringParent` says
 * whose; neither is any use alone. An override missing its parent would render
 * as an ordinary event *and* leave the occurrence it was meant to replace
 * standing, so the series would show that day twice — the kind of wrong the
 * user notices long after the edit that caused it.
 *
 * @throws If exactly one of the pair is present.
 */
function requirePairedOverride(event: FerryEvent): void {
    if (event.type !== "single") {
        return;
    }
    const hasId = event.recurrenceId !== undefined;
    const hasParent = event.recurringParent !== undefined;
    if (hasId === hasParent) {
        return;
    }
    throw new Error(
        hasId
            ? `"${event.title}" has a recurrenceId but no recurringParent, so nothing says which series it belongs to. Add recurringParent, or remove recurrenceId to make it an ordinary event.`
            : `"${event.title}" has a recurringParent but no recurrenceId, so nothing says which occurrence it replaces. Add recurrenceId, or remove recurringParent to make it an ordinary event.`
    );
}

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
    const event = {
        ...CommonSchema.parse(objectWithDefaults),
        ...TimeSchema.parse(objectWithDefaults),
        ...EventSchema.parse(objectWithDefaults),
    };
    requirePairedOverride(event);
    return event;
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
 * describes an event with no rule and stops parsing altogether. An override
 * that has been edited back into an ordinary event is the same story told with
 * `recurrenceId` — it would go on displacing an occurrence it no longer stands
 * in for.
 *
 * @param fields Output of `serializeEvent`.
 * @returns Keys to hand to the writer for removal.
 */
export function replacedKeys(fields: EventFrontmatter): string[] {
    return [
        ...INFERRED_KEYS,
        ...LEGACY_RECURRENCE_KEYS,
        ...OVERRIDE_KEYS,
    ].filter((key) => fields[key] === undefined);
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
