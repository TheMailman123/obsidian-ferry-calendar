import { exclusiveEndDate, inclusiveEndDate } from "./end_date";

describe("end date conversion", () => {
    it("turns a stored last day into an exclusive boundary", () => {
        expect(exclusiveEndDate("2026-03-19")).toBe("2026-03-20");
    });

    it("turns an exclusive boundary into a stored last day", () => {
        expect(inclusiveEndDate("2026-03-20")).toBe("2026-03-19");
    });

    it("round-trips", () => {
        expect(inclusiveEndDate(exclusiveEndDate("2026-03-19"))).toBe(
            "2026-03-19"
        );
    });

    it("crosses a month boundary", () => {
        expect(exclusiveEndDate("2026-01-31")).toBe("2026-02-01");
        expect(inclusiveEndDate("2026-02-01")).toBe("2026-01-31");
    });

    it("crosses a year boundary", () => {
        expect(exclusiveEndDate("2025-12-31")).toBe("2026-01-01");
        expect(inclusiveEndDate("2026-01-01")).toBe("2025-12-31");
    });

    it("handles a leap day", () => {
        expect(exclusiveEndDate("2028-02-28")).toBe("2028-02-29");
        expect(inclusiveEndDate("2028-03-01")).toBe("2028-02-29");
    });

    it("is unaffected by the local timezone", () => {
        // The shift is computed in UTC on purpose: a date-only string parsed
        // in a local zone and then formatted back can land on the wrong day.
        expect(exclusiveEndDate("2026-03-19")).toBe("2026-03-20");
        expect(inclusiveEndDate("2026-03-19")).toBe("2026-03-18");
    });

    it("throws on anything that is not an ISO date", () => {
        expect(() => exclusiveEndDate("19/03/2026")).toThrow(/Not an ISO date/);
        expect(() => inclusiveEndDate("")).toThrow(/Not an ISO date/);
        expect(() => exclusiveEndDate("2026-13-01")).toThrow(/Not an ISO date/);
        expect(() => exclusiveEndDate("tomorrow")).toThrow(/Not an ISO date/);
    });

    it("refuses a partial date rather than guessing at it", () => {
        // Luxon reads `2026-08` as the 1st of August and `2026` as New Year's
        // Day. `endDate` is hand-authored and the schema validates nothing, so
        // both reach here — and shifting one by a day gives a plausible answer
        // that is not what the note says.
        expect(() => exclusiveEndDate("2026-08")).toThrow(/Not an ISO date/);
        expect(() => exclusiveEndDate("2026")).toThrow(/Not an ISO date/);
        expect(() => exclusiveEndDate("2026-8-1")).toThrow(/Not an ISO date/);
    });
});
