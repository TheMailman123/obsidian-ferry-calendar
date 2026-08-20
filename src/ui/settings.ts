import FerryCalendarPlugin from "../main";
import {
    App,
    DropdownComponent,
    Notice,
    PluginSettingTab,
    Setting,
    TFile,
    TFolder,
} from "obsidian";
import { makeDefaultPartialCalendarSource, CalendarInfo } from "../types";
import { CalendarSettings } from "./components/CalendarSetting";
import { AddCalendarSource } from "./components/AddCalendarSource";
import * as ReactDOM from "react-dom";
import { createElement } from "react";
import { getDailyNoteSettings } from "obsidian-daily-notes-interface";
import ReactModal from "./ReactModal";
import { importCalendars } from "src/calendars/parsing/caldav/import";
import {
    listPropertiesInDirectory,
    previewDerivedSource,
} from "src/calendars/derived_preview";
import { formatTagList, parseTagList } from "src/calendars/tags";
import {
    DEFAULT_FILENAME_DATE_FORMAT,
    FILENAME_DATE_FORMAT_LABELS,
    FILENAME_DATE_FORMATS,
    FilenameDateFormat,
    isFilenameDateFormat,
} from "src/calendars/filenames";

/**
 * Where exported `.ics` files are written, relative to the vault root.
 *
 * A folder of its own rather than beside each calendar: the files are not
 * notes, nobody opens them in Obsidian, and keeping them together is what makes
 * them easy to find, to point a subscription at, and to gitignore — which
 * PLANNING §7.3 asks for, so an export is not committed and pushed by accident.
 *
 * The gitignoring itself is the user's to do, and the setting's description
 * says so. Writing to a vault's `.gitignore` would be the plugin editing a file
 * it does not own, in a repo it was never told about, to change what a tool it
 * has nothing to do with commits — one folder in a settings field is not worth
 * that authority. PLANNING §9.2 closed on this.
 */
export const DEFAULT_ICS_EXPORT_FOLDER = "_ics";

export interface FerryCalendarSettings {
    calendarSources: CalendarInfo[];
    /** @see DEFAULT_ICS_EXPORT_FOLDER */
    icsExportFolder: string;
    /**
     * Whether to raise a desktop notification before an event starts.
     *
     * Off by default, and deliberately: every calendar carries a reminder lead
     * time whether or not anyone has looked at it, so defaulting this on would
     * have an upgrade start popping up alerts nobody asked for. The lead time
     * is per calendar and shared with the ICS export — see `Notifier`.
     */
    desktopNotifications: boolean;
    defaultCalendar: number;
    firstDay: number;
    /**
     * Tag names, without their leading `#`, written onto an event note when the
     * plugin creates it. Empty by default: which tags a vault wants on its
     * event notes is that vault's business, not the plugin's.
     */
    eventTags: string[];
    initialView: {
        desktop: string;
        mobile: string;
    };
    timeFormat24h: boolean;
    clickToCreateEventFromMonthView: boolean;
    /**
     * Calendar ids whose events are hidden from the view, toggled from the
     * calendar key. Absence means visible, so an id that disappears — because
     * its calendar was renamed or removed — fails safe to a visible calendar
     * rather than one hidden with no row left to unhide it.
     */
    hiddenCalendars: string[];
    /** Whether the calendar key starts collapsed. */
    calendarKeyCollapsed: boolean;
    /**
     * How the date prefix of a working-calendar event filename is rendered.
     *
     * Changing this does not rename anything by itself: every existing note
     * simply starts disagreeing with its frontmatter, and the repair command
     * shows what it would do before it does it.
     */
    filenameDateFormat: FilenameDateFormat;
}

export const DEFAULT_SETTINGS: FerryCalendarSettings = {
    calendarSources: [],
    defaultCalendar: 0,
    firstDay: 0,
    eventTags: [],
    initialView: {
        desktop: "timeGridWeek",
        mobile: "timeGrid3Days",
    },
    timeFormat24h: false,
    clickToCreateEventFromMonthView: true,
    hiddenCalendars: [],
    calendarKeyCollapsed: false,
    filenameDateFormat: DEFAULT_FILENAME_DATE_FORMAT,
    icsExportFolder: DEFAULT_ICS_EXPORT_FOLDER,
    desktopNotifications: false,
};

const WEEKDAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

const INITIAL_VIEW_OPTIONS = {
    DESKTOP: {
        timeGridDay: "Day",
        timeGridWeek: "Week",
        dayGridMonth: "Month",
        listWeek: "List",
    },
    MOBILE: {
        timeGrid3Days: "3 Days",
        timeGridDay: "Day",
        listWeek: "List",
    },
};

export function addCalendarButton(
    app: App,
    plugin: FerryCalendarPlugin,
    containerEl: HTMLElement,
    submitCallback: (setting: CalendarInfo) => void,
    listUsedDirectories?: () => string[]
) {
    let dropdown: DropdownComponent;
    const directories = app.vault
        .getAllLoadedFiles()
        .filter((f) => f instanceof TFolder)
        .map((f) => f.path);

    return new Setting(containerEl)
        .setName("Calendars")
        .setDesc("Add calendar")
        .addDropdown(
            (d) =>
                (dropdown = d.addOptions({
                    local: "Full note",
                    dailynote: "Daily Note",
                    derived: "Custom directory (read-only)",
                    icloud: "iCloud",
                    caldav: "CalDAV",
                    ical: "Remote (.ics format)",
                }))
        )
        .addExtraButton((button) => {
            button.setTooltip("Add Calendar");
            button.setIcon("plus-with-circle");
            button.onClick(() => {
                let modal = new ReactModal(app, async () => {
                    await plugin.loadSettings();
                    const usedDirectories = (
                        listUsedDirectories
                            ? listUsedDirectories
                            : () =>
                                  plugin.settings.calendarSources
                                      .map(
                                          (s) =>
                                              s.type === "local" && s.directory
                                      )
                                      .filter((s): s is string => !!s)
                    )();
                    let headings: string[] = [];
                    let { template } = getDailyNoteSettings();

                    if (template) {
                        if (!template.endsWith(".md")) {
                            template += ".md";
                        }
                        const file = app.vault.getAbstractFileByPath(template);
                        if (file instanceof TFile) {
                            headings =
                                app.metadataCache
                                    .getFileCache(file)
                                    ?.headings?.map((h) => h.heading) || [];
                        }
                    }

                    return createElement(AddCalendarSource, {
                        source: makeDefaultPartialCalendarSource(
                            dropdown.getValue() as CalendarInfo["type"]
                        ),
                        directories,
                        usedDirectories,
                        headings,
                        listProperties: (directory, recursive) =>
                            listPropertiesInDirectory(
                                app,
                                directory,
                                recursive
                            ),
                        previewDerived: (draft) =>
                            previewDerivedSource(app, draft),
                        submit: async (source: CalendarInfo) => {
                            if (source.type === "caldav") {
                                try {
                                    let sources = await importCalendars(
                                        {
                                            type: "basic",
                                            username: source.username,
                                            password: source.password,
                                        },
                                        source.url
                                    );
                                    sources.forEach((source) =>
                                        submitCallback(source)
                                    );
                                } catch (e) {
                                    if (e instanceof Error) {
                                        new Notice(e.message);
                                    }
                                }
                            } else {
                                submitCallback(source);
                            }
                            modal.close();
                        },
                    });
                });
                modal.open();
            });
        });
}

export class FerryCalendarSettingTab extends PluginSettingTab {
    plugin: FerryCalendarPlugin;

    constructor(app: App, plugin: FerryCalendarPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async display(): Promise<void> {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl("h2", { text: "Calendar Preferences" });
        new Setting(containerEl)
            .setName("Desktop Initial View")
            .setDesc("Choose the initial view range on desktop devices.")
            .addDropdown((dropdown) => {
                Object.entries(INITIAL_VIEW_OPTIONS.DESKTOP).forEach(
                    ([value, display]) => {
                        dropdown.addOption(value, display);
                    }
                );
                dropdown.setValue(this.plugin.settings.initialView.desktop);
                dropdown.onChange(async (initialView) => {
                    this.plugin.settings.initialView.desktop = initialView;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Mobile Initial View")
            .setDesc("Choose the initial view range on mobile devices.")
            .addDropdown((dropdown) => {
                Object.entries(INITIAL_VIEW_OPTIONS.MOBILE).forEach(
                    ([value, display]) => {
                        dropdown.addOption(value, display);
                    }
                );
                dropdown.setValue(this.plugin.settings.initialView.mobile);
                dropdown.onChange(async (initialView) => {
                    this.plugin.settings.initialView.mobile = initialView;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Starting Day of the Week")
            .setDesc("Choose what day of the week to start.")
            .addDropdown((dropdown) => {
                WEEKDAYS.forEach((day, code) => {
                    dropdown.addOption(code.toString(), day);
                });
                dropdown.setValue(this.plugin.settings.firstDay.toString());
                dropdown.onChange(async (codeAsString) => {
                    this.plugin.settings.firstDay = Number(codeAsString);
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("24-hour format")
            .setDesc("Display the time in a 24-hour format.")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.timeFormat24h);
                toggle.onChange(async (val) => {
                    this.plugin.settings.timeFormat24h = val;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Event filename date format")
            .setDesc(
                "How the date is written at the start of event note filenames. " +
                    "Changing this does not rename existing notes: run " +
                    '"Repair event filenames" to see and approve the renames.'
            )
            .addDropdown((dropdown) => {
                FILENAME_DATE_FORMATS.forEach((format) => {
                    dropdown.addOption(
                        format,
                        FILENAME_DATE_FORMAT_LABELS[format]
                    );
                });
                dropdown.setValue(this.plugin.settings.filenameDateFormat);
                dropdown.onChange(async (value) => {
                    if (!isFilenameDateFormat(value)) {
                        throw new Error(
                            `Unknown filename date format ${value}.`
                        );
                    }
                    this.plugin.settings.filenameDateFormat = value;
                    // saveSettings rather than savePreferences: the calendars
                    // hold the format, so they have to be rebuilt with it.
                    await this.plugin.saveSettings();
                    await this.plugin.reportFilenameDrift();
                });
            });

        new Setting(containerEl)
            .setName("Tags for new event notes")
            .setDesc(
                "Tags written into the frontmatter of every event note the plugin creates, separated by commas. " +
                    "Leave empty for none. Existing notes are not touched, and a note's tags are never rewritten after it is created."
            )
            .addText((text) => {
                text.setPlaceholder("#INVISIBLE");
                text.setValue(formatTagList(this.plugin.settings.eventTags));
                text.onChange(async (val) => {
                    // Persisted on every keystroke, but without the cache
                    // reset: the calendars are built holding the tag list, and
                    // rebuilding every calendar once per character typed would
                    // put a notice on screen ten times for one word.
                    this.plugin.settings.eventTags = parseTagList(val);
                    await this.plugin.savePreferences();
                });
                // The rebuild that makes the new list take effect, once, when
                // the user has finished typing it.
                text.inputEl.addEventListener("blur", async () => {
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Click on a day in month view to create event")
            .setDesc("Switch off to open day view on click instead.")
            .addToggle((toggle) => {
                toggle.setValue(
                    this.plugin.settings.clickToCreateEventFromMonthView
                );
                toggle.onChange(async (val) => {
                    this.plugin.settings.clickToCreateEventFromMonthView = val;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("ICS export folder")
            .setDesc(
                "Folder in the vault for exported .ics files, one per calendar with export switched on. Point a subscription app on your phone at the file — the OS handles the alerts, since a plugin cannot. If your vault is a git repo, add this folder to its .gitignore: the plugin will not edit that file for you."
            )
            .addText((text) => {
                text.setPlaceholder(DEFAULT_ICS_EXPORT_FOLDER);
                text.setValue(this.plugin.settings.icsExportFolder);
                text.onChange(async (val) => {
                    // Falling back to the default rather than accepting an
                    // empty string, which would scatter the files across the
                    // vault root beside the user's notes.
                    this.plugin.settings.icsExportFolder =
                        val.trim() || DEFAULT_ICS_EXPORT_FOLDER;
                    await this.plugin.saveSettings();
                });
            });

        new Setting(containerEl)
            .setName("Desktop notifications")
            .setDesc(
                "Show a notification before an event starts, using each calendar's reminder time. Only while Obsidian is open on a desktop — on the phone the .ics export is what raises alerts."
            )
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.desktopNotifications);
                toggle.onChange(async (val) => {
                    this.plugin.settings.desktopNotifications = val;
                    await this.plugin.savePreferences();
                });
            });

        containerEl.createEl("h2", { text: "Manage Calendars" });
        addCalendarButton(
            this.app,
            this.plugin,
            containerEl,
            async (source: CalendarInfo) => {
                sourceList.addSource(source);
            },
            () =>
                sourceList.state.sources
                    .map((s) => s.type === "local" && s.directory)
                    .filter((s): s is string => !!s)
        );

        const sourcesDiv = containerEl.createDiv();
        sourcesDiv.style.display = "block";
        let sourceList = ReactDOM.render(
            createElement(CalendarSettings, {
                sources: this.plugin.settings.calendarSources,
                submit: async (settings: CalendarInfo[]) => {
                    this.plugin.settings.calendarSources = settings;
                    await this.plugin.saveSettings();
                },
            }),
            sourcesDiv
        );
    }
}
