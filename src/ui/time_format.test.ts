import { timeFormatFor } from "./time_format";

describe("timeFormatFor", () => {
    it("pins the 12-hour branch explicitly", () => {
        // The guard this module exists for: `locale: en-gb` renders 24-hour
        // times unless `hour12` says otherwise, so an implicit branch here
        // would silently override the setting with no way back.
        expect(timeFormatFor(false)).toMatchObject({ hour12: true });
    });

    it("pins the 24-hour branch explicitly", () => {
        expect(timeFormatFor(true)).toMatchObject({ hour12: false });
    });

    it("never leaves the clock to the locale", () => {
        for (const twentyFourHour of [true, false]) {
            expect(timeFormatFor(twentyFourHour)).toHaveProperty("hour12");
        }
    });

    it("renders a 12-hour time as en-GB would not", () => {
        const format = timeFormatFor(false) as Intl.DateTimeFormatOptions;
        const rendered = new Intl.DateTimeFormat("en-gb", {
            hour: format.hour,
            minute: format.minute,
            hour12: format.hour12,
            timeZone: "UTC",
        }).format(new Date(Date.UTC(2026, 7, 21, 13, 30)));
        expect(rendered).toBe("1:30 pm");
    });

    it("renders a 24-hour time under the same locale", () => {
        const format = timeFormatFor(true) as Intl.DateTimeFormatOptions;
        const rendered = new Intl.DateTimeFormat("en-gb", {
            hour: format.hour,
            minute: format.minute,
            hour12: format.hour12,
            timeZone: "UTC",
        }).format(new Date(Date.UTC(2026, 7, 21, 13, 30)));
        expect(rendered).toBe("13:30");
    });
});
