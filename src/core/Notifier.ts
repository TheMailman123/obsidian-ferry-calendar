import { DateTime } from "luxon";

import { EditableCalendar } from "../calendars/EditableCalendar";
import {
    Occurrence,
    StoredEntry,
    occurrencesInWindow,
} from "../calendars/occurrences";
import EventCache from "./EventCache";

/**
 * Reminding you about an event while Obsidian is open on the desktop.
 *
 * The other half of PLANNING §7.2. The `.ics` export is the reliable route and
 * the phone is what fires those alerts, because a plugin cannot: §7.1 is blunt
 * about there being no notification API and no background execution on mobile.
 * Desktop is the one place that constraint does not apply — Obsidian is an
 * Electron app, its renderer has the browser `Notification` API, and a plugin
 * that is running can use it.
 *
 * So this is deliberately the lesser route. It works when the machine is on and
 * Obsidian is open, and it says nothing at all otherwise. The export is what
 * you rely on; this is what saves you when you are already at the desk.
 *
 * ## Nothing is scheduled
 *
 * There are no timers per event. A timer set for tomorrow's 9am is a promise
 * this process cannot keep — the app gets closed, the laptop sleeps, the event
 * gets edited or deleted underneath it — so instead the caller ticks, and every
 * tick asks the same question from scratch: what starts soon enough to warn
 * about, given what the cache says right now? An event moved an hour later
 * between two ticks is simply not due yet on the second one.
 *
 * That also keeps PLANNING §8's rule intact. Occurrences are expanded across a
 * window a few minutes wide and thrown away; nothing here is stored except the
 * set of reminders already shown, which is pruned to the same window.
 */

/**
 * How far back the window reaches before now.
 *
 * Ticks are not instants: an occurrence can fall due between two of them, and
 * one with no lead time at all falls due exactly as it starts, which no tick
 * lands on. Reaching back a minute is what makes those reachable — a reminder a
 * few seconds late is a reminder, one that never comes is not.
 */
const GRACE_MINUTES = 1;

/** A reminder to show, already worded. */
export type Reminder = {
    /** The event's title, as the notification's heading. */
    title: string;
    /** When it starts, in words. */
    body: string;
    /** The occurrence it is about, for callers that want more than the text. */
    occurrence: Occurrence;
};

/**
 * How an occurrence's start reads at the moment it is announced.
 *
 * Relative, because that is the question being answered — "how long have I
 * got?" — with the clock time after it, because a number of minutes is easy to
 * lose track of once the notification has been sitting there a while.
 */
function describe(start: DateTime, now: DateTime): string {
    const minutes = Math.round(start.diff(now, "minutes").minutes);
    const clock = start.toLocaleString(DateTime.TIME_SIMPLE);
    if (minutes <= 0) {
        return `Starting now — ${clock}`;
    }
    if (minutes === 1) {
        return `In 1 minute — ${clock}`;
    }
    return `In ${minutes} minutes — ${clock}`;
}

export default class Notifier {
    private cache: EventCache;
    private show: (reminder: Reminder) => void;
    private enabled: () => boolean;
    private now: () => DateTime;

    /**
     * Reminders already shown, keyed by event and occurrence start.
     *
     * Keyed by the occurrence rather than the event because a series is one
     * event and many reminders. Pruned on every tick to what is still in the
     * window, so it stays the size of a few minutes of calendar rather than
     * growing for as long as Obsidian is open.
     *
     * Empty after a reload, which means restarting Obsidian a few minutes
     * before a meeting can show its reminder a second time. That is the right
     * way round: the alternative is suppressing a reminder that was never
     * actually shown, and a duplicate is an annoyance where a miss is a
     * failure.
     */
    private shown = new Set<string>();

    /**
     * @param cache The event cache, read on every tick so an edit takes effect
     * immediately rather than at the next reload.
     * @param show What to do with a reminder. Injected so this class never
     * touches Electron or the DOM, which is what makes it testable at all.
     * @param enabled Whether desktop notifications are switched on, read per
     * tick rather than captured, since the setting can change while running.
     * @param now The clock, overridable so tests can stand at a chosen moment.
     */
    constructor(
        cache: EventCache,
        show: (reminder: Reminder) => void,
        enabled: () => boolean,
        now: () => DateTime = () => DateTime.now()
    ) {
        this.cache = cache;
        this.show = show;
        this.enabled = enabled;
        this.now = now;
    }

    /**
     * Show whatever has fallen due since the last tick.
     *
     * Safe to call as often as you like: the work is proportional to the events
     * in the next few minutes, and anything already announced is skipped.
     *
     * @returns The reminders shown, for the caller's benefit — tests, mostly.
     */
    check(): Reminder[] {
        if (!this.enabled()) {
            return [];
        }
        // A cache still filling has some of the calendar in it, which is worse
        // than none: a series whose override has not loaded yet still shows
        // the occurrence the override was going to cancel, and a reminder for
        // it cannot be taken back once it has been shown.
        if (!this.cache.initialized) {
            return [];
        }
        const leads = this.leads();
        if (leads.size === 0) {
            return [];
        }

        const now = this.now();
        const from = now.minus({ minutes: GRACE_MINUTES });
        const to = now.plus({ minutes: Math.max(...leads.values()) });

        const entries: StoredEntry[] = [...leads.keys()].flatMap((calendarId) =>
            this.cache
                .eventsInCalendar(calendarId)
                .map(({ id, event }) => ({ id, calendarId, event }))
        );

        const upcoming = occurrencesInWindow(
            entries,
            from,
            to,
            this.cache.overriddenOccurrences()
        ).filter(
            (occurrence) =>
                // All-day events are left out: their start is midnight, so a
                // fifteen-minute lead would wake you at a quarter to twelve the
                // night before to tell you about tomorrow. They are the export's
                // business, where the phone decides when to raise them.
                !occurrence.allDay &&
                // `occurrencesInWindow` keeps an event that is already under
                // way, which is right for a list of what is on and wrong for a
                // reminder: a trip that began on Tuesday is not about to start.
                occurrence.start >= from
        );

        // Pruned against the window rather than by age, so the set can never
        // outlive what it is protecting against. An occurrence that has left
        // the window cannot re-enter it — time only moves one way.
        const live = new Set(upcoming.map((occurrence) => key(occurrence)));
        this.shown = new Set([...this.shown].filter((k) => live.has(k)));

        const due: Reminder[] = [];
        for (const occurrence of upcoming) {
            const lead = leads.get(occurrence.calendarId) ?? 0;
            if (occurrence.start > now.plus({ minutes: lead })) {
                continue;
            }
            const id = key(occurrence);
            if (this.shown.has(id)) {
                continue;
            }
            this.shown.add(id);
            due.push({
                title: occurrence.event.title,
                body: describe(occurrence.start, now),
                occurrence,
            });
        }

        // Shown one at a time on purpose. `show` reaches a platform API that
        // can fail, and two events falling due together is exactly when losing
        // the second one matters — it is already marked as shown, so a later
        // tick will not try again.
        const failures: unknown[] = [];
        for (const reminder of due) {
            try {
                this.show(reminder);
            } catch (e) {
                failures.push(e);
            }
        }
        if (failures.length > 0) {
            console.error(
                `FC: ${failures.length} reminder(s) could not be shown.`,
                ...failures
            );
        }
        return due;
    }

    /**
     * Forget what has been announced.
     *
     * For the caller that has just rebuilt the cache underneath this: the event
     * IDs the set is keyed by are handed out per session and are reused after a
     * reset, so a stale set would silence a reminder belonging to a different
     * event entirely.
     */
    reset(): void {
        this.shown.clear();
    }

    /**
     * How long before an event each calendar wants warning, in minutes.
     *
     * The same per-calendar setting the export writes its `VALARM` from, so the
     * desktop and the phone warn you at the same moment about the same event.
     * `null` means no alarm at all and the calendar is left out entirely.
     *
     * Only calendars the plugin owns the notes of. A derived calendar is a
     * projection of notes that already live in a working calendar, so
     * reminding from both would show the same event twice, and a remote
     * calendar's own server already has whatever alarms it was given.
     *
     * @returns Calendar ID → lead time. Calendars with no reminder are absent.
     */
    private leads(): Map<string, number> {
        const leads = new Map<string, number>();
        for (const [calendarId, calendar] of this.cache.calendars.entries()) {
            if (!(calendar instanceof EditableCalendar)) {
                continue;
            }
            const minutes = this.cache.infoFor(calendarId)?.reminderMinutes;
            if (minutes === null || minutes === undefined) {
                continue;
            }
            leads.set(calendarId, Math.max(0, minutes));
        }
        return leads;
    }
}

/** Identity of a single reminder: this event, at this start. */
function key(occurrence: Occurrence): string {
    return `${occurrence.id}::${occurrence.start.toISO()}`;
}
