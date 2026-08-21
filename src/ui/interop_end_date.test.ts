import { parseEvent } from "../types/schema";
import {
    dateEndpointsToFrontmatter,
    fromEventApi,
    toEventInput,
} from "./interop";

/**
 * `endDate` names the last day an event covers — PLANNING §13.5.
 *
 * FullCalendar disagrees on every boundary it owns: an all-day `end`, whether
 * rendered, selected or dragged, is exclusive. So each crossing of that seam
 * shifts by a day, and the failure mode is quiet — a trip drawing one day short
 * looks like a rendering quirk, not a conversion bug. These tests pin the
 * direction at each crossing, and pin that a timed event never shifts at all.
 */

const eventApi = (start: Date, end: Date, allDay: boolean) =>
    ({
        id: "1",
        title: "BOATWEEK",
        start,
        end,
        allDay,
        extendedProps: { isTask: false },
    } as any);

describe("rendering a stored end date", () => {
    it("hands FullCalendar the day after the last day covered", () => {
        const rendered = toEventInput(
            "1",
            parseEvent({
                title: "BOATWEEK",
                allDay: true,
                date: "2025-12-09",
                endDate: "2025-12-15",
            })
        );
        // The 15th is covered, so the exclusive boundary is the 16th. Handing
        // over the 15th would draw the week a day short — the bug this fixes.
        expect(rendered).toMatchObject({
            start: "2025-12-09",
            end: "2025-12-16",
        });
    });

    it("leaves a single all-day event with no end at all", () => {
        const rendered = toEventInput(
            "1",
            parseEvent({ title: "x", allDay: true, date: "2025-12-09" })
        );
        expect(rendered).toMatchObject({ start: "2025-12-09", end: undefined });
    });

    it("does not shift a timed event's end date", () => {
        // A timed event ends at an instant. There is no last-day ambiguity to
        // resolve, so `endDate` passes straight through.
        const rendered = toEventInput(
            "1",
            parseEvent({
                title: "overnight",
                allDay: false,
                date: "2025-12-09",
                endDate: "2025-12-10",
                startTime: "22:00",
                endTime: "02:00",
            })
        );
        expect(rendered).toMatchObject({
            start: "2025-12-09T22:00:00",
            end: "2025-12-10T02:00:00",
        });
    });
});

describe("an endDate the schema let through", () => {
    // `ParsedDate` is `z.string()` and validates nothing, so `endDate` reaches
    // the renderer as whatever was typed in the note.
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    afterAll(() => errors.mockRestore());

    it.each(["tomorrow", "19/03/2026", "2026-13-01", "2026-08"])(
        "drops the one event rather than throwing, for %s",
        (endDate) => {
            // `toEventInput` runs over every event in a source on every render.
            // A throw here would take the whole calendar off the screen because
            // one note is wrong, which is the failure mode this pass exists to
            // stop happening.
            expect(() =>
                toEventInput(
                    "1",
                    parseEvent({
                        title: "x",
                        allDay: true,
                        date: "2025-12-09",
                        endDate,
                    })
                )
            ).not.toThrow();
            expect(
                toEventInput(
                    "1",
                    parseEvent({
                        title: "x",
                        allDay: true,
                        date: "2025-12-09",
                        endDate,
                    })
                )
            ).toBeNull();
        }
    );

    it("says so in the console", () => {
        errors.mockClear();
        toEventInput(
            "1",
            parseEvent({
                title: "x",
                allDay: true,
                date: "2025-12-09",
                endDate: "tomorrow",
            })
        );
        expect(errors).toHaveBeenCalledWith(
            expect.stringContaining("tomorrow")
        );
    });

    it("still renders a timed event whose endDate is unreadable", () => {
        // The timed branch never shifts the date, so there is nothing to fail
        // on — `combineDateTimeStrings` is what refuses it, as it always did.
        expect(
            toEventInput(
                "1",
                parseEvent({
                    title: "x",
                    allDay: false,
                    date: "2025-12-09",
                    endDate: "tomorrow",
                    startTime: "09:00",
                    endTime: "10:00",
                })
            )
        ).toBeNull();
    });
});

describe("reading an all-day selection back", () => {
    it("stores the last day the selection covered", () => {
        // Selecting the 9th through the 15th hands back the 16th.
        expect(
            dateEndpointsToFrontmatter(
                new Date(2025, 11, 9),
                new Date(2025, 11, 16),
                true
            )
        ).toMatchObject({ date: "2025-12-09", endDate: "2025-12-15" });
    });

    it("stores no end for a one-day selection", () => {
        // A single month-view cell hands back the next day. This used to be
        // corrected in `view.ts`, in month view only, which is why a month
        // selection and an all-day-row selection disagreed.
        expect(
            dateEndpointsToFrontmatter(
                new Date(2025, 11, 9),
                new Date(2025, 11, 10),
                true
            )
        ).toMatchObject({ date: "2025-12-09", endDate: undefined });
    });

    it("does not shift a timed selection", () => {
        expect(
            dateEndpointsToFrontmatter(
                new Date(2025, 11, 9, 9, 0),
                new Date(2025, 11, 9, 10, 30),
                false
            )
        ).toMatchObject({
            date: "2025-12-09",
            endDate: undefined,
            startTime: "09:00",
            endTime: "10:30",
        });
    });
});

describe("reading a drag back", () => {
    it("stores the last day an all-day drag covered", () => {
        expect(
            fromEventApi(
                eventApi(new Date(2025, 11, 10), new Date(2025, 11, 17), true)
            )
        ).toMatchObject({ date: "2025-12-10", endDate: "2025-12-16" });
    });

    it("invents no end date when a one-day all-day event is dragged", () => {
        // Before §13.5 this wrote `endDate` a day past the start, which under
        // the inclusive reading is a two-day event — and which made every
        // all-day drag in a daily-note calendar throw.
        expect(
            fromEventApi(
                eventApi(new Date(2025, 11, 10), new Date(2025, 11, 11), true)
            )
        ).toMatchObject({ date: "2025-12-10", endDate: null });
    });

    it("does not shift a timed drag", () => {
        expect(
            fromEventApi(
                eventApi(
                    new Date(2025, 11, 10, 9, 0),
                    new Date(2025, 11, 10, 10, 0),
                    false
                )
            )
        ).toMatchObject({
            date: "2025-12-10",
            endDate: null,
            startTime: "09:00",
            endTime: "10:00",
        });
    });
});

describe("the round trip", () => {
    it("returns a multi-day all-day event unchanged", () => {
        const stored = parseEvent({
            title: "HALIDAYS",
            allDay: true,
            date: "2026-01-10",
            endDate: "2026-01-17",
        });
        const rendered = toEventInput("1", stored) as any;
        const readBack = fromEventApi(
            eventApi(
                new Date(`${rendered.start}T00:00:00`),
                new Date(`${rendered.end}T00:00:00`),
                true
            )
        );
        expect(readBack).toMatchObject({
            date: "2026-01-10",
            endDate: "2026-01-17",
        });
    });
});
