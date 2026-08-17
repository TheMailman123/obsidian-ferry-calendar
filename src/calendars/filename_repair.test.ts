import { FerryEvent } from "../types";
import { RECURRING_DIR } from "./filenames";
import {
    countRenames,
    countUnplannable,
    describePlan,
    PlannableNote,
    planRepairs,
} from "./filename_repair";

const DIR = "CALENDARS/SOCIAL";

const event = (title: string, date: string): FerryEvent =>
    ({
        type: "single",
        title,
        allDay: true,
        date,
        endDate: null,
    } as FerryEvent);

/** A note holding an event, named as the legacy scheme would have named it. */
const legacy = (title: string, date: string): PlannableNote => ({
    path: `${DIR}/${date} ${title}.md`,
    basename: `${date} ${title}`,
    event: event(title, date),
});

/** A note holding an event, named as the plugin names it today. */
const current = (
    basename: string,
    title: string,
    date: string
): PlannableNote => ({
    path: `${DIR}/${basename}.md`,
    basename,
    event: event(title, date),
});

describe("planRepairs", () => {
    it("plans nothing for a folder whose names already agree", () => {
        const plan = planRepairs(DIR, [
            current(
                "20251121_Games_Night_Owens",
                "Games Night, Owens",
                "2025-11-21"
            ),
            current("20251204_NANA_LIFT", "NANA LIFT", "2025-12-04"),
        ]);
        expect(plan.renames).toEqual([]);
        expect(plan.alreadyCorrect).toBe(2);
        expect(plan.unplannable).toEqual([]);
    });

    it("plans the migration off the legacy scheme", () => {
        const plan = planRepairs(DIR, [
            legacy("Games Night, Owens", "2025-11-21"),
            legacy("NANA LIFT", "2025-12-04"),
        ]);
        expect(plan.renames).toEqual([
            {
                from: `${DIR}/2025-11-21 Games Night, Owens.md`,
                to: `${DIR}/20251121_Games_Night_Owens.md`,
            },
            {
                from: `${DIR}/2025-12-04 NANA LIFT.md`,
                to: `${DIR}/20251204_NANA_LIFT.md`,
            },
        ]);
        expect(plan.alreadyCorrect).toBe(0);
    });

    it("is idempotent — the plan it produces has nothing left to do", () => {
        const notes = [
            legacy("Games Night, Owens", "2025-11-21"),
            legacy("NANA LIFT", "2025-12-04"),
        ];
        const plan = planRepairs(DIR, notes);

        const afterwards = notes.map((note): PlannableNote => {
            const rename = plan.renames.find((r) => r.from === note.path);
            if (!rename) {
                return note;
            }
            return {
                ...note,
                path: rename.to,
                basename: rename.to.slice(DIR.length + 1, -".md".length),
            };
        });

        expect(planRepairs(DIR, afterwards).renames).toEqual([]);
    });

    it("honours the configured date format", () => {
        const plan = planRepairs(
            DIR,
            [current("20251121_NANA_LIFT", "NANA LIFT", "2025-11-21")],
            "yyyy-mm-dd"
        );
        expect(plan.renames).toEqual([
            {
                from: `${DIR}/20251121_NANA_LIFT.md`,
                to: `${DIR}/2025-11-21_NANA_LIFT.md`,
            },
        ]);
    });

    it("suffixes two notes that want the same name", () => {
        const plan = planRepairs(DIR, [
            legacy("Gym", "2025-11-21"),
            {
                path: `${DIR}/gym again.md`,
                basename: "gym again",
                event: event("Gym", "2025-11-21"),
            },
        ]);
        expect(plan.renames.map((r) => r.to)).toEqual([
            `${DIR}/20251121_Gym.md`,
            `${DIR}/20251121_Gym_2.md`,
        ]);
    });

    it("leaves an existing collision suffix alone", () => {
        const plan = planRepairs(DIR, [
            current("20251121_Gym", "Gym", "2025-11-21"),
            current("20251121_Gym_2", "Gym", "2025-11-21"),
        ]);
        expect(plan.renames).toEqual([]);
        expect(plan.alreadyCorrect).toBe(2);
    });

    it("does not plan a rename onto a name that is occupied", () => {
        // The occupying note is drifting too, but its name is not released:
        // renames that depend on each other could half-succeed into a
        // collision.
        const plan = planRepairs(DIR, [
            legacy("Gym", "2025-11-21"),
            {
                path: `${DIR}/20251121_Gym.md`,
                basename: "20251121_Gym",
                event: event("Gym", "2025-11-22"),
            },
        ]);
        expect(plan.renames).toEqual([
            {
                from: `${DIR}/2025-11-21 Gym.md`,
                to: `${DIR}/20251121_Gym_2.md`,
            },
            {
                from: `${DIR}/20251121_Gym.md`,
                to: `${DIR}/20251122_Gym.md`,
            },
        ]);
    });

    it("does not plan a rename onto a note that is not an event", () => {
        const plan = planRepairs(DIR, [
            {
                path: `${DIR}/20251121_Gym.md`,
                basename: "20251121_Gym",
                event: null,
            },
            legacy("Gym", "2025-11-21"),
        ]);
        expect(plan.renames).toEqual([
            {
                from: `${DIR}/2025-11-21 Gym.md`,
                to: `${DIR}/20251121_Gym_2.md`,
            },
        ]);
    });

    it("ignores notes that are not events", () => {
        const plan = planRepairs(DIR, [
            { path: `${DIR}/README.md`, basename: "README", event: null },
        ]);
        expect(plan.renames).toEqual([]);
        expect(plan.alreadyCorrect).toBe(0);
        expect(plan.unplannable).toEqual([]);
    });

    it("reports an event it cannot name rather than dropping it", () => {
        const plan = planRepairs(DIR, [
            {
                path: `${DIR}/broken.md`,
                basename: "broken",
                event: event("Gym", "the 21st"),
            },
        ]);
        expect(plan.renames).toEqual([]);
        expect(plan.unplannable).toHaveLength(1);
        expect(plan.unplannable[0].path).toBe(`${DIR}/broken.md`);
        expect(plan.unplannable[0].reason).toMatch(/unusable date/);
    });
});

describe("planRepairs across _recurring/", () => {
    const rule = (title: string, start: string): FerryEvent =>
        ({
            type: "recurring",
            title,
            allDay: true,
            recurring: { start, freq: "weekly" },
        } as FerryEvent);

    /** A note holding a recurrence master, in the folder masters belong in. */
    const master = (
        basename: string,
        title: string,
        start: string
    ): PlannableNote => ({
        path: `${DIR}/${RECURRING_DIR}/${basename}.md`,
        basename,
        event: rule(title, start),
    });

    it("leaves a correctly filed master alone", () => {
        const plan = planRepairs(DIR, [
            master("20260317_Gym", "Gym", "2026-03-17"),
        ]);
        expect(plan.renames).toEqual([]);
        expect(plan.alreadyCorrect).toBe(1);
    });

    it("renames a master whose DTSTART was edited by hand", () => {
        const plan = planRepairs(DIR, [
            master("20260317_Gym", "Gym", "2026-04-07"),
        ]);
        expect(plan.renames).toEqual([
            {
                from: `${DIR}/${RECURRING_DIR}/20260317_Gym.md`,
                to: `${DIR}/${RECURRING_DIR}/20260407_Gym.md`,
            },
        ]);
    });

    it("moves a master that is sitting among the dated notes", () => {
        // Where a hand-authored one lands, since nothing put it in the folder
        // masters belong in.
        const plan = planRepairs(DIR, [
            {
                path: `${DIR}/20260317_Gym.md`,
                basename: "20260317_Gym",
                event: rule("Gym", "2026-03-17"),
            },
        ]);
        expect(plan.renames).toEqual([
            {
                from: `${DIR}/20260317_Gym.md`,
                to: `${DIR}/${RECURRING_DIR}/20260317_Gym.md`,
            },
        ]);
    });

    it("moves a note that has stopped recurring back out", () => {
        const plan = planRepairs(DIR, [
            {
                path: `${DIR}/${RECURRING_DIR}/20260317_Gym.md`,
                basename: "20260317_Gym",
                event: event("Gym", "2026-03-17"),
            },
        ]);
        expect(plan.renames).toEqual([
            {
                from: `${DIR}/${RECURRING_DIR}/20260317_Gym.md`,
                to: `${DIR}/20260317_Gym.md`,
            },
        ]);
    });

    it("lets the two folders hold the same name", () => {
        // Separate namespaces: a master and the override of one of its
        // occurrences are named for the same day and the same title.
        const plan = planRepairs(DIR, [
            current("20260317_Gym", "Gym", "2026-03-17"),
            master("20260317_Gym", "Gym", "2026-03-17"),
        ]);
        expect(plan.renames).toEqual([]);
        expect(plan.alreadyCorrect).toBe(2);
    });

    it("suffixes a master that would collide with another master", () => {
        const plan = planRepairs(DIR, [
            master("20260317_Gym", "Gym", "2026-03-17"),
            master("Gym rule", "Gym", "2026-03-17"),
        ]);
        expect(plan.renames).toEqual([
            {
                from: `${DIR}/${RECURRING_DIR}/Gym rule.md`,
                to: `${DIR}/${RECURRING_DIR}/20260317_Gym_2.md`,
            },
        ]);
    });
});

describe("plan reporting", () => {
    const plans = [
        planRepairs(DIR, [legacy("Gym", "2025-11-21")]),
        planRepairs("CALENDARS/MISC", [
            {
                path: "CALENDARS/MISC/broken.md",
                basename: "broken",
                event: event("Gym", "nope"),
            },
        ]),
    ];

    it("counts across calendars", () => {
        expect(countRenames(plans)).toBe(1);
        expect(countUnplannable(plans)).toBe(1);
    });

    it("lists every rename individually rather than just a count", () => {
        const text = describePlan(plans).join("\n");
        expect(text).toContain(`${DIR}/2025-11-21 Gym.md`);
        expect(text).toContain(`${DIR}/20251121_Gym.md`);
        expect(text).toContain("SKIPPED CALENDARS/MISC/broken.md");
    });
});
