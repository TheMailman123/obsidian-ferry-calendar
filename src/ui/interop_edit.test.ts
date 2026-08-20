import { parseEvent, isOverride } from "../types/schema";
import { fromEventApi } from "./interop";

/**
 * Reading an edit back off the calendar without losing what the calendar never
 * knew — PLANNING §13.2.
 *
 * `fromEventApi` had no tests at all, which is how a drag came to strip an
 * override's link to its series. The stripping was not merely a lost field:
 * `replacedKeys` lists the override pair as obsolete once it is absent, so the
 * write path removed both keys from the note and the master resumed drawing the
 * occurrence.
 */

const draggedTo = (start: Date, end: Date, allDay = false) =>
    ({
        id: "7",
        title: "yeep",
        start,
        end,
        allDay,
        extendedProps: { isTask: false },
    } as any);

const override = parseEvent({
    title: "yeep",
    allDay: false,
    startTime: "12:30",
    endTime: "18:30",
    date: "2026-08-26",
    endDate: null,
    uid: "abc123",
    recurrenceId: "2026-08-28",
    recurringParent: "[[CALENDARS/SOCIAL/_recurring/20260818_yeep]]",
});

describe("editing an event that is already an override", () => {
    it("stays an override when it is nudged", () => {
        const moved = fromEventApi(
            draggedTo(
                new Date(2026, 7, 26, 13, 0),
                new Date(2026, 7, 26, 19, 0)
            ),
            override
        );
        expect(isOverride(moved)).toBe(true);
        expect(moved).toMatchObject({
            startTime: "13:00",
            endTime: "19:00",
            recurrenceId: "2026-08-28",
            recurringParent: "[[CALENDARS/SOCIAL/_recurring/20260818_yeep]]",
        });
    });

    it("keeps recurrenceId when moved to yet another day", () => {
        // §9.1: the note takes the new date, and recurrenceId goes on naming
        // the occurrence it replaces. The two routinely differ, and moving it
        // again does not make them agree.
        const moved = fromEventApi(
            draggedTo(
                new Date(2026, 7, 27, 12, 30),
                new Date(2026, 7, 27, 18, 30)
            ),
            override
        );
        expect(moved).toMatchObject({
            date: "2026-08-27",
            recurrenceId: "2026-08-28",
        });
    });

    it("keeps the uid the export identifies it by", () => {
        const moved = fromEventApi(
            draggedTo(
                new Date(2026, 7, 26, 13, 0),
                new Date(2026, 7, 26, 19, 0)
            ),
            override
        );
        // Losing it would make the next export look like a fresh event, so a
        // subscriber would delete and recreate rather than update.
        expect(moved.uid).toBe("abc123");
    });
});

describe("editing an ordinary event", () => {
    it("gains nothing it did not already have", () => {
        const plain = parseEvent({
            title: "Games Night",
            allDay: false,
            startTime: "17:30",
            endTime: "22:00",
            date: "2025-11-21",
        });
        const moved = fromEventApi(
            draggedTo(
                new Date(2025, 10, 22, 18, 0),
                new Date(2025, 10, 22, 22, 30)
            ),
            plain
        );
        expect(isOverride(moved)).toBe(false);
        expect(moved.uid).toBeUndefined();
        expect(moved).toMatchObject({ date: "2025-11-22", startTime: "18:00" });
    });

    it("carries nothing when there is no stored event to carry from", () => {
        // The drag that materialises an override in the first place: the
        // occurrence becomes an ordinary dated event, and `overrideOf` is what
        // stamps it afterwards.
        const fresh = fromEventApi(
            draggedTo(
                new Date(2026, 7, 26, 13, 0),
                new Date(2026, 7, 26, 19, 0)
            )
        );
        expect(isOverride(fresh)).toBe(false);
        expect(fresh.uid).toBeUndefined();
    });
});
