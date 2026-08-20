import { endDateToStore } from "./EditEvent";

/**
 * The one non-obvious rule in the create/edit form — PLANNING §13.3.
 *
 * The modal has held `endDate` in state and submitted it since the fork, and
 * never rendered an input for it, so a multi-day event could only be made by
 * hand-authoring the note. Adding the input makes what gets *stored* worth
 * pinning: three different blanks all have to become null, and one of them is a
 * calendar that throws rather than a note that reads oddly.
 */
describe("endDateToStore", () => {
    it("keeps a real span", () => {
        expect(endDateToStore("2025-12-15", "2025-12-09", false)).toBe(
            "2025-12-15"
        );
    });

    it("drops a blank end date", () => {
        expect(endDateToStore("", "2025-12-09", false)).toBeNull();
        expect(endDateToStore(undefined, "2025-12-09", false)).toBeNull();
        expect(endDateToStore(null, "2025-12-09", false)).toBeNull();
    });

    it("drops an end date equal to the start", () => {
        // The same day said twice. `endDate` is inclusive, so this is a valid
        // thing to type and simply adds nothing to the note.
        expect(endDateToStore("2025-12-09", "2025-12-09", false)).toBeNull();
    });

    it("drops any span bound for a daily note", () => {
        // `DailyNoteCalendar.modifyEvent` throws on a multi-day event. The
        // input is disabled and cleared when that calendar is chosen; this is
        // the backstop for a value that somehow survives the switch.
        expect(endDateToStore("2025-12-15", "2025-12-09", true)).toBeNull();
    });
});
