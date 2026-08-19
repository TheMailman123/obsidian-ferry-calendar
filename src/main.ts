import {
    MarkdownView,
    Notice,
    Platform,
    Plugin,
    TFile,
    debounce,
} from "obsidian";
import {
    CalendarView,
    FERRY_CALENDAR_SIDEBAR_VIEW_TYPE,
    FERRY_CALENDAR_VIEW_TYPE,
} from "./ui/view";
import { renderCalendar } from "./ui/calendar";
import { toEventInput } from "./ui/interop";
import {
    DEFAULT_SETTINGS,
    FerryCalendarSettings,
    FerryCalendarSettingTab,
} from "./ui/settings";
import { PLUGIN_SLUG } from "./types";
import EventCache from "./core/EventCache";
import IcsExporter from "./core/IcsExporter";
import Notifier from "./core/Notifier";
import { ObsidianIO } from "./ObsidianAdapter";
import { launchCreateModal } from "./ui/event_modal";
import FullNoteCalendar from "./calendars/FullNoteCalendar";
import DailyNoteCalendar from "./calendars/DailyNoteCalendar";
import DerivedCalendar from "./calendars/DerivedCalendar";
import ICSCalendar from "./calendars/ICSCalendar";
import CalDAVCalendar from "./calendars/CalDAVCalendar";
import {
    CalendarRepairPlan,
    countRenames,
    countUnplannable,
    describePlan,
} from "./calendars/filename_repair";
import { FilenameRepairModal } from "./ui/repair_modal";

/**
 * How often to look for an event that has fallen due.
 *
 * Half a minute: fine enough that a reminder is never noticeably late, coarse
 * enough that the work — expanding a few minutes of calendar — is nothing.
 */
const TICK_MS = 30_000;

export default class FerryCalendarPlugin extends Plugin {
    settings: FerryCalendarSettings = DEFAULT_SETTINGS;
    cache: EventCache = new EventCache({
        local: (info) =>
            info.type === "local"
                ? new FullNoteCalendar(
                      new ObsidianIO(this.app),
                      info.color,
                      info.directory,
                      this.settings.filenameDateFormat
                  )
                : null,
        dailynote: (info) =>
            info.type === "dailynote"
                ? new DailyNoteCalendar(
                      new ObsidianIO(this.app),
                      info.color,
                      info.heading
                  )
                : null,
        derived: (info) =>
            info.type === "derived"
                ? new DerivedCalendar(
                      new ObsidianIO(this.app),
                      info.color,
                      info.name,
                      info.directory,
                      info.recursive,
                      info.mapping
                  )
                : null,
        ical: (info) =>
            info.type === "ical" ? new ICSCalendar(info.color, info.url) : null,
        caldav: (info) =>
            info.type === "caldav"
                ? new CalDAVCalendar(
                      info.color,
                      info.name,
                      {
                          type: "basic",
                          username: info.username,
                          password: info.password,
                      },
                      info.url,
                      info.homeUrl
                  )
                : null,
        FOR_TEST_ONLY: () => null,
    });

    renderCalendar = renderCalendar;
    processFrontmatter = toEventInput;

    /**
     * Writes the enabled calendars out as `.ics` files.
     *
     * The export folder is passed as a function rather than a value so that
     * changing the setting takes effect without reloading the plugin.
     */
    private exporter: IcsExporter = new IcsExporter(
        this.cache,
        new ObsidianIO(this.app),
        () => this.settings.icsExportFolder
    );

    /**
     * Export once the vault has settled, rather than on every cache update.
     *
     * A single edit produces several updates — the write itself, the metadata
     * change it causes, and on a calendar's first export one more per event as
     * uids are assigned. Collapsing them into one pass is what keeps this from
     * rewriting the same file a dozen times for one edit; the exporter's own
     * content comparison then absorbs whatever still gets through.
     *
     * Deliberately not awaited by anything. An export is a consequence of a
     * change, never a step in making one, and a failing export must not take
     * the edit that triggered it down with it.
     */
    private scheduleExport = debounce(
        () => {
            this.exportCalendars().catch((e) =>
                console.error("Ferry Calendar: could not export calendars", e)
            );
        },
        2000,
        true
    );

    /**
     * Desktop reminders, off unless switched on in settings.
     *
     * The `Notification` constructor is the browser API, which exists here
     * because Obsidian's desktop app is Electron and this code is its renderer.
     * On mobile there is no such thing, which is why the tick is never
     * registered there at all — see `Notifier` and PLANNING §7.1.
     */
    private notifier: Notifier = new Notifier(
        this.cache,
        ({ title, body }) => new Notification(title, { body }),
        () => this.settings.desktopNotifications
    );

    async activateView() {
        const leaves = this.app.workspace
            .getLeavesOfType(FERRY_CALENDAR_VIEW_TYPE)
            .filter((l) => (l.view as CalendarView).inSidebar === false);
        if (leaves.length === 0) {
            const leaf = this.app.workspace.getLeaf("tab");
            await leaf.setViewState({
                type: FERRY_CALENDAR_VIEW_TYPE,
                active: true,
            });
        } else {
            await Promise.all(
                leaves.map((l) => (l.view as CalendarView).onOpen())
            );
        }
    }
    async onload() {
        await this.loadSettings();

        this.cache.reset(this.settings.calendarSources);

        this.registerEvent(
            this.app.metadataCache.on("changed", (file) => {
                this.cache.fileUpdated(file);
            })
        );

        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                if (file instanceof TFile) {
                    console.debug("FILE RENAMED", file.path);
                    this.cache.deleteEventsAtPath(oldPath);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                if (file instanceof TFile) {
                    console.debug("FILE DELETED", file.path);
                    this.cache.deleteEventsAtPath(file.path);
                }
            })
        );

        // Every change to any event, including ones made outside the plugin,
        // arrives here. The export is opt-in per calendar, so for a vault with
        // none enabled this costs a debounce timer and nothing else.
        this.cache.on("update", () => this.scheduleExport());

        // @ts-ignore
        window.cache = this.cache;

        this.registerView(
            FERRY_CALENDAR_VIEW_TYPE,
            (leaf) => new CalendarView(leaf, this, false)
        );

        this.registerView(
            FERRY_CALENDAR_SIDEBAR_VIEW_TYPE,
            (leaf) => new CalendarView(leaf, this, true)
        );

        this.addRibbonIcon(
            "calendar-glyph",
            "Open Ferry Calendar",
            async (_: MouseEvent) => {
                await this.activateView();
            }
        );

        this.addSettingTab(new FerryCalendarSettingTab(this.app, this));

        this.addCommand({
            id: "ferry-calendar-new-event",
            name: "New Event",
            callback: () => {
                launchCreateModal(this, {});
            },
        });

        this.addCommand({
            id: "ferry-calendar-reset",
            name: "Reset Event Cache",
            callback: () => {
                this.cache.reset(this.settings.calendarSources);
                this.notifier.reset();
                this.app.workspace.detachLeavesOfType(FERRY_CALENDAR_VIEW_TYPE);
                this.app.workspace.detachLeavesOfType(
                    FERRY_CALENDAR_SIDEBAR_VIEW_TYPE
                );
                new Notice("Ferry Calendar has been reset.");
            },
        });

        this.addCommand({
            id: "ferry-calendar-repair-filenames",
            name: "Repair event filenames",
            callback: () => {
                this.repairFilenames();
            },
        });

        this.addCommand({
            id: "ferry-calendar-export-ics",
            name: "Export calendars to ICS",
            callback: () => {
                this.exportCalendars(true).catch((e) => {
                    console.error("Ferry Calendar: export failed", e);
                    new Notice(`Ferry Calendar: export failed. ${e}`);
                });
            },
        });

        this.addCommand({
            id: "ferry-calendar-revalidate",
            name: "Revalidate remote calendars",
            callback: () => {
                this.cache.revalidateRemoteCalendars(true);
            },
        });

        this.addCommand({
            id: "ferry-calendar-open",
            name: "Open Calendar",
            callback: () => {
                this.activateView();
            },
        });

        this.addCommand({
            id: "ferry-calendar-open-sidebar",
            name: "Open in sidebar",
            callback: () => {
                if (
                    this.app.workspace.getLeavesOfType(
                        FERRY_CALENDAR_SIDEBAR_VIEW_TYPE
                    ).length
                ) {
                    return;
                }
                const leaf = this.app.workspace.getRightLeaf(false);
                if (!leaf) {
                    new Notice("No right sidebar available to open in.");
                    return;
                }
                leaf.setViewState({
                    type: FERRY_CALENDAR_SIDEBAR_VIEW_TYPE,
                });
            },
        });

        (this.app.workspace as any).registerHoverLinkSource(PLUGIN_SLUG, {
            display: "Ferry Calendar",
            defaultMod: true,
        });

        // Deferred until the layout is ready because the check reads parsed
        // frontmatter. Run at onload time the metadata cache may still be
        // filling, and every note would look like it was not an event.
        this.app.workspace.onLayoutReady(() => {
            this.reportFilenameDrift().catch((e) =>
                console.error("Could not check event filenames", e)
            );
            // A vault edited while Obsidian was closed has changes the export
            // never saw. Writing once at startup is what makes the file on
            // disk true rather than merely up to date with this session.
            this.scheduleExport();
        });

        // Desktop only. Mobile has no notification API to call and stops
        // running the moment Obsidian is backgrounded, so a timer there would
        // burn battery to no effect (PLANNING §7.1).
        if (Platform.isDesktopApp) {
            this.registerInterval(
                window.setInterval(() => this.notifier.check(), TICK_MS)
            );
        }
    }

    /**
     * Plan the filename repair across every working calendar.
     *
     * Read-only. Derived calendars are absent by construction: the plugin
     * writes nothing to the notes behind them, and renaming someone's source
     * note to suit a projection would be exactly the write authority a derived
     * calendar is defined not to have.
     */
    private async planFilenameRepairs(): Promise<CalendarRepairPlan[]> {
        const calendars = [...this.cache.calendars.values()].flatMap((c) =>
            c instanceof FullNoteCalendar ? c : []
        );
        return Promise.all(calendars.map((c) => c.planFilenameRepair()));
    }

    /**
     * Report — but do not fix — event notes whose filenames disagree with
     * their frontmatter.
     *
     * Frontmatter is authoritative, so a disagreement is always the filename's
     * fault and the fix is never ambiguous. It still is not applied here.
     * Loading a plugin should not rewrite the names of notes in a vault; the
     * user gets told what is wrong and runs the repair when they choose to.
     */
    async reportFilenameDrift(): Promise<void> {
        const plans = await this.planFilenameRepairs();
        const renames = countRenames(plans);
        const unplannable = countUnplannable(plans);
        if (renames === 0 && unplannable === 0) {
            return;
        }

        // Every case listed in the console, not just the count: a summary is
        // not enough to work out which note is wrong or why.
        console.warn(
            [
                "Ferry Calendar: event filenames need repair",
                ...describePlan(plans),
            ].join("\n")
        );

        const parts: string[] = [];
        if (renames > 0) {
            parts.push(
                `${renames} event note${renames === 1 ? "" : "s"} disagree${
                    renames === 1 ? "s" : ""
                } with its frontmatter`
            );
        }
        if (unplannable > 0) {
            parts.push(`${unplannable} could not be named at all`);
        }
        new Notice(
            `Ferry Calendar: ${parts.join(
                ", "
            )}. Run "Repair event filenames" to review the fix.`,
            10000
        );
    }

    /**
     * Show the repair plan, and rename only if the user approves it.
     *
     * The dry run is not a separate command that can be skipped: the plan is
     * always computed and shown first, and the renames happen behind a button
     * in the modal. Safe to run repeatedly — a plan against notes that already
     * agree with their frontmatter is empty.
     */
    private async repairFilenames(): Promise<void> {
        const plans = await this.planFilenameRepairs();
        const renames = countRenames(plans);
        const unplannable = countUnplannable(plans);
        const lines = describePlan(plans);

        console.warn(
            ["Ferry Calendar: filename repair plan", ...lines].join("\n")
        );

        const summary =
            renames > 0
                ? `${renames} note(s) will be renamed. Frontmatter is not touched, and inbound links are updated automatically.`
                : unplannable === 0
                ? "Every event filename already agrees with its frontmatter. Nothing to do."
                : `No filenames need repair, but ${unplannable} note(s) could not be named. See below.`;

        new FilenameRepairModal(this.app, summary, lines, renames, async () => {
            const calendars = new Map(
                [...this.cache.calendars.values()].flatMap((c) =>
                    c instanceof FullNoteCalendar
                        ? [[c.directory, c] as const]
                        : []
                )
            );
            let applied = 0;
            for (const plan of plans) {
                const calendar = calendars.get(plan.directory);
                if (!calendar) {
                    throw new Error(
                        `Calendar for ${plan.directory} is no longer registered.`
                    );
                }
                applied += (await calendar.applyFilenameRepair(plan)).length;
            }

            // A rename fires vault.on("rename"), which drops the events at
            // the old path, but no metadata change follows to add them back
            // at the new one. Rebuild rather than leave the view short of
            // every note that just moved.
            this.cache.reset(this.settings.calendarSources);
            await this.cache.populate();
            this.cache.resync();

            new Notice(
                `Ferry Calendar: renamed ${applied} event note${
                    applied === 1 ? "" : "s"
                }.`
            );
        }).open();
    }

    /**
     * Write the enabled calendars out as `.ics` files.
     *
     * @param announce Whether to report the result with a notice. On the
     * command it is the only feedback there is; on the automatic export it
     * would be a popup every time an event was dragged.
     * @returns Paths actually written, which is empty whenever nothing
     * changed — the ordinary result, not a failure.
     */
    async exportCalendars(announce = false): Promise<string[]> {
        // Exporting a half-built cache would write files describing a vault
        // that has not finished loading, and the comparison would then read
        // those as the current truth.
        if (!this.cache.initialized) {
            if (announce) {
                new Notice(
                    "Ferry Calendar is still loading. Try the export again in a moment."
                );
            }
            return [];
        }

        const written = await this.exporter.exportAll();
        if (announce) {
            new Notice(
                written.length === 0
                    ? "Ferry Calendar: exports are already up to date."
                    : `Ferry Calendar: wrote ${written.length} calendar${
                          written.length === 1 ? "" : "s"
                      }.`
            );
        }
        return written;
    }

    onunload() {
        // A queued export would run against a cache the plugin is tearing
        // down, and write whatever was left of it over a good file.
        this.scheduleExport.cancel();
        this.app.workspace.detachLeavesOfType(FERRY_CALENDAR_VIEW_TYPE);
        this.app.workspace.detachLeavesOfType(FERRY_CALENDAR_SIDEBAR_VIEW_TYPE);
    }

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData()
        );
    }

    async saveSettings() {
        new Notice("Resetting the event cache with new settings...");
        await this.saveData(this.settings);
        this.cache.reset(this.settings.calendarSources);
        // Event IDs are handed out per session and reused after a reset, so
        // what the notifier has already announced no longer means anything.
        this.notifier.reset();
        await this.cache.populate();
        this.cache.resync();
    }

    /**
     * Persist settings without disturbing the event cache.
     *
     * `saveSettings` rebuilds every calendar from disk and refetches the remote
     * ones. That is correct when the set of calendar *sources* changes, but far
     * too heavy for a preference like calendar visibility — and its resync
     * rebuilds all event sources, which would undo the in-place source toggle
     * it was called to persist.
     */
    async savePreferences() {
        await this.saveData(this.settings);
    }
}
