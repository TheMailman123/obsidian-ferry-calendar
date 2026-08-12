import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
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
        });
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

    onunload() {
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
