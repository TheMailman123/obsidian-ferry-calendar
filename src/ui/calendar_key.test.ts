import {
    calendarLabel,
    isCalendarVisible,
    pruneHiddenCalendars,
    setCalendarVisibility,
} from "./calendar_key";

describe("isCalendarVisible", () => {
    it("treats an unlisted calendar as visible", () => {
        expect(isCalendarVisible([], "local::WORK")).toBe(true);
        expect(isCalendarVisible(["local::HOME"], "local::WORK")).toBe(true);
    });

    it("treats a listed calendar as hidden", () => {
        expect(isCalendarVisible(["local::WORK"], "local::WORK")).toBe(false);
    });
});

describe("setCalendarVisibility", () => {
    it("adds an id when hiding", () => {
        expect(setCalendarVisibility([], "local::WORK", false)).toEqual([
            "local::WORK",
        ]);
    });

    it("removes an id when showing", () => {
        expect(
            setCalendarVisibility(["local::WORK"], "local::WORK", true)
        ).toEqual([]);
    });

    it("does not duplicate an already-hidden id", () => {
        expect(
            setCalendarVisibility(["local::WORK"], "local::WORK", false)
        ).toEqual(["local::WORK"]);
    });

    it("leaves other calendars alone", () => {
        expect(
            setCalendarVisibility(
                ["local::HOME", "local::WORK"],
                "local::WORK",
                true
            )
        ).toEqual(["local::HOME"]);
    });

    it("does not mutate the input", () => {
        const hidden = ["local::WORK"];
        setCalendarVisibility(hidden, "local::HOME", false);
        expect(hidden).toEqual(["local::WORK"]);
    });
});

describe("pruneHiddenCalendars", () => {
    it("keeps ids that still exist", () => {
        expect(
            pruneHiddenCalendars(
                ["local::WORK"],
                ["local::WORK", "local::HOME"]
            )
        ).toEqual(["local::WORK"]);
    });

    it("drops ids with no live calendar", () => {
        // The directory was renamed, so "local::OLD" can never match again.
        expect(
            pruneHiddenCalendars(
                ["local::OLD", "local::WORK"],
                ["local::NEW", "local::WORK"]
            )
        ).toEqual(["local::WORK"]);
    });

    it("deduplicates", () => {
        expect(
            pruneHiddenCalendars(
                ["local::WORK", "local::WORK"],
                ["local::WORK"]
            )
        ).toEqual(["local::WORK"]);
    });

    it("returns empty when no calendars are configured", () => {
        expect(pruneHiddenCalendars(["local::WORK"], [])).toEqual([]);
    });

    it("does not mutate the input", () => {
        const hidden = ["local::OLD"];
        pruneHiddenCalendars(hidden, []);
        expect(hidden).toEqual(["local::OLD"]);
    });
});

describe("calendarLabel", () => {
    it("uses the last path segment of a local directory", () => {
        expect(calendarLabel({ type: "local", name: "CALENDARS/SOCIAL" })).toBe(
            "SOCIAL"
        );
    });

    it("handles a root-level directory", () => {
        expect(calendarLabel({ type: "local", name: "SOCIAL" })).toBe("SOCIAL");
    });

    it("ignores a trailing slash", () => {
        expect(calendarLabel({ type: "local", name: "CALENDARS/WORK/" })).toBe(
            "WORK"
        );
    });

    it("falls back to the raw name when a directory is only slashes", () => {
        // basename() would be empty here; the raw value is still better than "".
        expect(calendarLabel({ type: "local", name: "/" })).toBe("/");
    });

    it("names a daily note calendar by its heading", () => {
        expect(calendarLabel({ type: "dailynote", name: "Events" })).toBe(
            "Daily notes: Events"
        );
    });

    it("names a daily note calendar with no heading", () => {
        expect(calendarLabel({ type: "dailynote", name: "" })).toBe(
            "Daily notes"
        );
    });

    it("reduces an ICS url to its host", () => {
        expect(
            calendarLabel({
                type: "ical",
                name: "https://calendar.google.com/calendar/ical/abc/basic.ics",
            })
        ).toBe("calendar.google.com");
    });

    it("falls back to the raw value for an unparseable ICS url", () => {
        // Predates URL validation in settings; must not break the whole view.
        expect(calendarLabel({ type: "ical", name: "not a url" })).toBe(
            "not a url"
        );
    });

    it("uses the server-supplied name for CalDAV", () => {
        expect(calendarLabel({ type: "caldav", name: "Shared Work" })).toBe(
            "Shared Work"
        );
    });
});
