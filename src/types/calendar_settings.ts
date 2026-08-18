import { ZodError, z } from "zod";
import { FerryEvent } from "./schema";
import {
    derivedMappingSchema,
    emptyDerivedMapping,
} from "../calendars/parsing/derived";

const calendarOptionsSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("local"), directory: z.string() }),
    z.object({ type: z.literal("dailynote"), heading: z.string() }),
    z.object({ type: z.literal("ical"), url: z.string().url() }),
    z.object({
        // A read-only projection of notes that exist for other reasons. The
        // mapping describes how their frontmatter becomes events; see
        // calendars/parsing/derived.ts.
        type: z.literal("derived"),
        // Display name, and part of the calendar's identity: one folder can
        // carry several mappings, each its own calendar.
        name: z.string().min(1),
        directory: z.string(),
        recursive: z.boolean().default(false),
        mapping: derivedMappingSchema,
    }),
    z.object({
        type: z.literal("caldav"),
        name: z.string(),
        url: z.string().url(),
        homeUrl: z.string().url(),
        username: z.string(),
        password: z.string(),
    }),
]);

const colorValidator = z.object({ color: z.string() });

/**
 * Whether and how a calendar is exported for the phone to subscribe to.
 *
 * Opt-in, per calendar, off by default — PLANNING §7.3 makes that a security
 * boundary rather than a convenience: an exported file leaves the vault's
 * protection the moment it syncs to a device, so nothing is exported unless it
 * was chosen. There is no vault-wide sweep and there is not meant to be one.
 *
 * The reminder lead time lives here, not on the event, because that is what was
 * asked for: one value per calendar, and an event needing a different one goes
 * in a different calendar. A frontmatter key was offered and declined, so the
 * absence of per-event reminders is a decision rather than a gap.
 */
const icsExportValidator = z.object({
    exportToICS: z.boolean().default(false),
    /** Minutes before an event to alert, or null for no alarm at all. */
    reminderMinutes: z.number().nullable().default(15),
});

export type TestSource = {
    type: "FOR_TEST_ONLY";
    id: string;
    events?: FerryEvent[];
};

export type CalendarInfo = (
    | z.infer<typeof calendarOptionsSchema>
    | TestSource
) &
    z.infer<typeof colorValidator> &
    // Partial, so a calendar constructed in code — a test double, a source
    // being built up in the add-calendar form — does not have to say it is not
    // exported. `parseCalendarInfo` fills both in for anything loaded from
    // settings, and every reader treats absence as "not exported", which is the
    // safe direction for an opt-in that governs what leaves the vault.
    Partial<z.infer<typeof icsExportValidator>>;

export function parseCalendarInfo(obj: unknown): CalendarInfo {
    const options = calendarOptionsSchema.parse(obj);
    const color = colorValidator.parse(obj);
    // Defaults rather than a required field, so settings saved before the
    // export existed load unchanged and stay unexported.
    const icsExport = icsExportValidator.parse(obj);

    return { ...options, ...color, ...icsExport };
}

export function safeParseCalendarInfo(obj: unknown): CalendarInfo | null {
    try {
        return parseCalendarInfo(obj);
    } catch (e) {
        if (e instanceof ZodError) {
            console.debug("Parsing calendar info failed with errors", {
                obj,
                error: e.message,
            });
        }
        return null;
    }
}

/**
 * Construct a partial calendar source of the specified type
 */
export function makeDefaultPartialCalendarSource(
    type: CalendarInfo["type"] | "icloud"
): Partial<CalendarInfo> {
    if (type === "derived") {
        // Seeded with the mapping defaults so the form starts from a shape the
        // schema would accept, rather than from a blank object the user has to
        // fill in field by field to find out what is required.
        return {
            type: "derived",
            color: getComputedStyle(document.body)
                .getPropertyValue("--interactive-accent")
                .trim(),
            name: "",
            directory: "",
            recursive: false,
            mapping: emptyDerivedMapping(),
        };
    }

    if (type === "icloud") {
        return {
            type: "caldav",
            color: getComputedStyle(document.body)
                .getPropertyValue("--interactive-accent")
                .trim(),
            url: "https://caldav.icloud.com",
        };
    }

    return {
        type: type,
        color: getComputedStyle(document.body)
            .getPropertyValue("--interactive-accent")
            .trim(),
    };
}
