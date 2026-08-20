/**
 * The clock format for event times and time-grid axis labels.
 *
 * Split out of `calendar.ts` so the one rule that matters here can be tested
 * without standing up a calendar: the 12-hour branch must say `hour12: true`
 * out loud. `Intl.DateTimeFormat` decides 12- versus 24-hour from the locale
 * unless it is told otherwise, and the plugin sets `locale: en-gb` (§13.1) to
 * get dd/mm dates — which is a 24-hour locale. Leaving the 12-hour branch to
 * FullCalendar's default formatter would therefore render 24-hour times and the
 * `timeFormat24h` setting would have no way back.
 */
import type { FormatterInput } from "@fullcalendar/core";

/**
 * Build the formatter used for both `eventTimeFormat` and `slotLabelFormat`.
 *
 * @param twentyFourHour the `timeFormat24h` setting.
 * @returns a FullCalendar formatter that pins the clock explicitly. The 12-hour
 *   form keeps FullCalendar's own niceties — `1pm` rather than `1:00 PM` — so
 *   that making the branch explicit does not change how the default settings
 *   look; the 24-hour form is unchanged from what the plugin already shipped.
 */
export function timeFormatFor(twentyFourHour: boolean): FormatterInput {
    if (twentyFourHour) {
        return { hour: "numeric", minute: "2-digit", hour12: false };
    }
    return {
        hour: "numeric",
        minute: "2-digit",
        omitZeroMinute: true,
        meridiem: "short",
        hour12: true,
    };
}
