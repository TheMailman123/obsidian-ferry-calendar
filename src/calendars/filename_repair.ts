import { FerryEvent } from "../types";
import {
    basenameForEvent,
    basenameMatchesEvent,
    DEFAULT_FILENAME_DATE_FORMAT,
    disambiguate,
    FilenameDateFormat,
} from "./filenames";

/**
 * Planning for bringing event filenames back in line with their frontmatter.
 *
 * Frontmatter is authoritative and the plugin maintains the filename derived
 * from it, but only ever at a moment the user chose. Editing an event renames
 * its note immediately, because the user just asked for that. Everything else —
 * a date hand-edited in the note, a title changed in a text editor, notes
 * written by an older version of the plugin, or the filename date format being
 * changed in settings — is *detected* on load and reported, and repaired only
 * when the repair command is run.
 *
 * The split matters because this is the one part of the plugin that renames
 * files in a real vault. Repairing automatically on load would mean that
 * installing a build silently rewrote every event note before the user had seen
 * a single one of the renames.
 *
 * Planning is pure and separate from applying so that the dry run and the real
 * run are the same computation, and so the plan can be shown before anything is
 * written.
 */

/** A single rename the repair would perform, as full vault paths. */
export type PlannedRename = {
    from: string;
    to: string;
};

/** A note the repair deliberately will not touch, and why. */
export type UnplannableNote = {
    path: string;
    reason: string;
};

/** What the repair would do to one working calendar. */
export type CalendarRepairPlan = {
    /** Directory of the calendar, for display. */
    directory: string;
    renames: PlannedRename[];
    unplannable: UnplannableNote[];
    /** Notes whose filenames already agree with their frontmatter. */
    alreadyCorrect: number;
};

/**
 * One note in a calendar's folder, as the planner needs to see it.
 *
 * Notes that are not events are included rather than filtered out by the
 * caller: the plugin has no opinion about their names, but those names are
 * still occupied and a rename must not land on one.
 */
export type PlannableNote = {
    /** Full vault path. */
    path: string;
    /** Filename without the `.md` extension. */
    basename: string;
    /** Parsed event, or null if this note is not an event note. */
    event: FerryEvent | null;
};

/**
 * Work out which notes in a calendar folder need renaming.
 *
 * Target names are reserved as they are assigned, and the names of notes that
 * are staying put are never released. That means a note wanting a name another
 * drifting note currently holds takes a `_2` suffix rather than waiting for the
 * other to move: renames then never depend on each other, so applying the plan
 * cannot half-succeed into a collision, and the result is stable when the
 * command is run again.
 *
 * @param directory Directory of the calendar being planned.
 * @param notes Every note directly in that directory.
 * @param format Filename date format the user has configured.
 */
export function planRepairs(
    directory: string,
    notes: PlannableNote[],
    format: FilenameDateFormat = DEFAULT_FILENAME_DATE_FORMAT
): CalendarRepairPlan {
    const taken = new Set(notes.map((n) => n.basename));
    const renames: PlannedRename[] = [];
    const unplannable: UnplannableNote[] = [];
    let alreadyCorrect = 0;

    for (const note of notes) {
        if (note.event === null) {
            continue;
        }

        let expected: string;
        try {
            expected = basenameForEvent(note.event, format);
        } catch (e) {
            // The event carries a date the plugin cannot read, so there is no
            // correct name to move it to. Reported rather than dropped: a note
            // quietly left behind by a bulk rename is the kind of thing nobody
            // notices for a year.
            unplannable.push({
                path: note.path,
                reason: e instanceof Error ? e.message : String(e),
            });
            continue;
        }

        if (basenameMatchesEvent(note.basename, expected)) {
            alreadyCorrect++;
            continue;
        }

        const target = disambiguate(expected, (candidate) =>
            taken.has(candidate)
        );
        taken.add(target);
        renames.push({
            from: note.path,
            to: `${directory}/${target}.md`,
        });
    }

    return { directory, renames, unplannable, alreadyCorrect };
}

/** Total number of renames across a set of per-calendar plans. */
export function countRenames(plans: CalendarRepairPlan[]): number {
    return plans.reduce((total, plan) => total + plan.renames.length, 0);
}

/** Total number of notes that could not be planned. */
export function countUnplannable(plans: CalendarRepairPlan[]): number {
    return plans.reduce((total, plan) => total + plan.unplannable.length, 0);
}

/**
 * Render a plan as lines of text, for the console and the dry-run view.
 *
 * Every planned rename is listed individually. A summary count is not enough to
 * decide whether to go ahead with rewriting the names of notes in a vault.
 */
export function describePlan(plans: CalendarRepairPlan[]): string[] {
    const lines: string[] = [];
    for (const plan of plans) {
        lines.push(
            `${plan.directory} — ${plan.renames.length} to rename, ${plan.alreadyCorrect} already correct`
        );
        for (const { from, to } of plan.renames) {
            lines.push(`  ${from}`);
            lines.push(`    → ${to}`);
        }
        for (const { path, reason } of plan.unplannable) {
            lines.push(`  SKIPPED ${path}`);
            lines.push(`    ${reason}`);
        }
    }
    return lines;
}
