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

export default class FerryCalendarPlugin extends Plugin {
    settings: FerryCalendarSettings = DEFAULT_SETTINGS;
    cache: EventCache = new EventCache({
        local: (info) =>
            info.type === "local"
                ? new FullNoteCalendar(
                      new ObsidianIO(this.app),
                      info.color,
                      info.directory
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
