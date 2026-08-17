import "./overrides.css";
import { ItemView, Menu, Notice, WorkspaceLeaf } from "obsidian";
import { Calendar, EventSourceInput } from "@fullcalendar/core";
import { renderCalendar } from "./calendar";
import FerryCalendarPlugin from "../main";
import { FCError, PLUGIN_SLUG } from "../types";
import {
    dateEndpointsToFrontmatter,
    fromEventApi,
    occurrenceDate,
    toEventInput,
} from "./interop";
import { renderOnboarding } from "./onboard";
import { deleteEventWithScope, openFileForEvent } from "./actions";
import { launchCreateModal, launchEditModal } from "./event_modal";
import { isTask, toggleTask, unmakeTask } from "src/ui/tasks";
import { FerryEventSource, UpdateViewCallback } from "src/core/EventCache";
import {
    isCalendarVisible,
    pruneHiddenCalendars,
    renderCalendarKey,
    setCalendarVisibility,
} from "./calendar_key";

export const FERRY_CALENDAR_VIEW_TYPE = "ferry-calendar-view";
export const FERRY_CALENDAR_SIDEBAR_VIEW_TYPE = "ferry-calendar-sidebar-view";

function getCalendarColors(color: string | null | undefined): {
    color: string;
    textColor: string;
} {
    let textVar = getComputedStyle(document.body).getPropertyValue(
        "--text-on-accent"
    );
    if (color) {
        const m = color
            .slice(1)
            .match(color.length == 7 ? /(\S{2})/g : /(\S{1})/g);
        if (m) {
            const r = parseInt(m[0], 16),
                g = parseInt(m[1], 16),
                b = parseInt(m[2], 16);
            const brightness = (r * 299 + g * 587 + b * 114) / 1000;
            if (brightness > 150) {
                textVar = "black";
            }
        }
    }

    return {
        color:
            color ||
            getComputedStyle(document.body).getPropertyValue(
                "--interactive-accent"
            ),
        textColor: textVar,
    };
}

export class CalendarView extends ItemView {
    plugin: FerryCalendarPlugin;
    inSidebar: boolean;
    fullCalendarView: Calendar | null = null;
    callback: UpdateViewCallback | null = null;
    /** Container for the calendar key, redrawn whenever the calendars change. */
    private keyEl: HTMLElement | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        plugin: FerryCalendarPlugin,
        inSidebar = false
    ) {
        super(leaf);
        this.plugin = plugin;
        this.inSidebar = inSidebar;
    }

    getIcon(): string {
        return "calendar-glyph";
    }

    getViewType() {
        return this.inSidebar
            ? FERRY_CALENDAR_SIDEBAR_VIEW_TYPE
            : FERRY_CALENDAR_VIEW_TYPE;
    }

    getDisplayText() {
        return this.inSidebar ? "Ferry Calendar" : "Calendar";
    }

    private translateSource({
        events,
        editable,
        color,
        id,
    }: FerryEventSource): EventSourceInput {
        // Asked once per source rather than once per event: the answer is a
        // pass over the whole store, and every master in this calendar needs
        // to know which of its occurrences an override has taken over.
        const overridden = this.plugin.cache.overriddenOccurrences();
        return {
            id,
            events: events.flatMap(
                (e) => toEventInput(e.id, e.event, overridden.get(e.id)) || []
            ),
            editable,
            ...getCalendarColors(color),
        };
    }

    /**
     * Every event source the calendar should currently be showing.
     *
     * Hidden calendars are filtered out *here* rather than at the point of
     * rendering, because this is what the resync handler rebuilds from. Layering
     * visibility on top of it instead would let any remote revalidation quietly
     * bring hidden calendars back.
     */
    translateSources(): EventSourceInput[] {
        const { hiddenCalendars } = this.plugin.settings;
        return this.plugin.cache
            .getAllEvents()
            .filter((source) => isCalendarVisible(hiddenCalendars, source.id))
            .map((source) => this.translateSource(source));
    }

    private isVisible(calendarId: string): boolean {
        return isCalendarVisible(
            this.plugin.settings.hiddenCalendars,
            calendarId
        );
    }

    /**
     * Add or remove a single calendar's event source in place.
     *
     * Toggling one source avoids the full teardown that `removeAllEventSources`
     * would cause, which visibly flickers every other calendar on screen.
     */
    private applyVisibility(calendarId: string, visible: boolean): void {
        const view = this.fullCalendarView;
        if (!view) {
            return;
        }

        if (!visible) {
            view.getEventSourceById(calendarId)?.remove();
            return;
        }

        if (view.getEventSourceById(calendarId)) {
            return;
        }

        const source = this.plugin.cache
            .getAllEvents()
            .find((s) => s.id === calendarId);
        if (!source) {
            throw new Error(
                `Cannot show calendar '${calendarId}': it is not registered in the cache.`
            );
        }
        view.addEventSource(this.translateSource(source));
    }

    /**
     * Redraw the key from the cache's current calendars.
     *
     * Called from the cache's update callback, which is synchronous, so the
     * promise is handled here rather than returned. A failure to redraw the key
     * must not take down the event handler that also refreshes the events.
     */
    private refreshKey(): void {
        if (!this.keyEl) {
            return;
        }
        this.renderKey(this.keyEl).catch((e) => {
            console.error("Failed to render the calendar key.", e);
            if (e instanceof Error) {
                new Notice(e.message);
            }
        });
    }

    /** Persist a toggle and reflect it in the calendar. */
    private async toggleCalendar(
        calendarId: string,
        visible: boolean
    ): Promise<void> {
        this.plugin.settings.hiddenCalendars = setCalendarVisibility(
            this.plugin.settings.hiddenCalendars,
            calendarId,
            visible
        );
        // Deliberately not saveSettings(): that resets and repopulates the
        // whole cache, and its resync would rebuild every source.
        await this.plugin.savePreferences();
        this.applyVisibility(calendarId, visible);
    }

    /**
     * Draw the key, first discarding hidden ids with no matching calendar.
     *
     * Editing a calendar in settings changes its id, so without pruning here the
     * stale entries would pile up in data.json indefinitely.
     */
    private async renderKey(parent: HTMLElement): Promise<void> {
        const sources = this.plugin.cache.getAllEvents();
        const pruned = pruneHiddenCalendars(
            this.plugin.settings.hiddenCalendars,
            sources.map((s) => s.id)
        );
        if (pruned.length !== this.plugin.settings.hiddenCalendars.length) {
            this.plugin.settings.hiddenCalendars = pruned;
            await this.plugin.savePreferences();
        }

        renderCalendarKey(
            parent,
            sources.map(({ id, name, type, color }) => ({
                id,
                name,
                type,
                color: getCalendarColors(color).color,
            })),
            this.plugin.settings.hiddenCalendars,
            this.plugin.settings.calendarKeyCollapsed,
            {
                onToggle: (id, visible) => this.toggleCalendar(id, visible),
                onCollapse: async (collapsed) => {
                    this.plugin.settings.calendarKeyCollapsed = collapsed;
                    await this.plugin.savePreferences();
                },
            }
        );
    }

    async onOpen() {
        await this.plugin.loadSettings();
        if (!this.plugin.cache) {
            new Notice("Ferry Calendar event cache not loaded.");
            return;
        }
        if (!this.plugin.cache.initialized) {
            await this.plugin.cache.populate();
        }

        const container = this.containerEl.children[1];
        container.empty();

        if (
            this.plugin.settings.calendarSources.filter(
                (s) => s.type !== "FOR_TEST_ONLY"
            ).length === 0
        ) {
            this.keyEl = null;
            renderOnboarding(this.app, this.plugin, container.createEl("div"));
            return;
        }

        // Created before the calendar so the key sits above it. Populated once
        // the calendar exists, since toggling a row acts on it.
        const keyEl = container.createDiv({ cls: "ferry-key-container" });
        this.keyEl = keyEl;
        let calendarEl = container.createEl("div");

        const sources: EventSourceInput[] = this.translateSources();

        if (this.fullCalendarView) {
            this.fullCalendarView.destroy();
            this.fullCalendarView = null;
        }
        this.fullCalendarView = renderCalendar(calendarEl, sources, {
            forceNarrow: this.inSidebar,
            eventClick: async (info) => {
                try {
                    const modified =
                        info.jsEvent.getModifierState("Control") ||
                        info.jsEvent.getModifierState("Meta");

                    // A read-only event is a view onto a note the plugin does
                    // not own, so there is nothing to edit: a click opens the
                    // note itself, and a modified click opens it in a split.
                    if (!this.plugin.cache.isEventEditable(info.event.id)) {
                        await openFileForEvent(
                            this.plugin.cache,
                            this.app,
                            info.event.id,
                            modified
                        );
                    } else if (modified) {
                        await openFileForEvent(
                            this.plugin.cache,
                            this.app,
                            info.event.id
                        );
                    } else {
                        launchEditModal(
                            this.plugin,
                            info.event.id,
                            info.event.start
                                ? occurrenceDate(info.event.start)
                                : null
                        );
                    }
                } catch (e) {
                    if (e instanceof Error) {
                        console.warn(e);
                        new Notice(e.message);
                    }
                }
            },
            select: async (start, end, allDay, viewType) => {
                if (viewType === "dayGridMonth") {
                    // Month view will set the end day to the next day even on a single-day event.
                    // This is problematic when moving an event created in the month view to the
                    // time grid to give it a time.

                    // The fix is just to subtract 1 from the end date before processing.
                    end.setDate(end.getDate() - 1);
                }
                const partialEvent = dateEndpointsToFrontmatter(
                    start,
                    end,
                    allDay
                );
                try {
                    if (
                        this.plugin.settings.clickToCreateEventFromMonthView ||
                        viewType !== "dayGridMonth"
                    ) {
                        launchCreateModal(this.plugin, partialEvent);
                    } else {
                        this.fullCalendarView?.changeView("timeGridDay");
                        this.fullCalendarView?.gotoDate(start);
                    }
                } catch (e) {
                    if (e instanceof Error) {
                        console.error(e);
                        new Notice(e.message);
                    }
                }
            },
            modifyEvent: async (newEvent, oldEvent) => {
                try {
                    // The stored event is what a recurring one is edited
                    // against: the view hands back a single occurrence, and a
                    // rule rebuilt from that would not be the rule the user
                    // wrote.
                    const existing = this.plugin.cache.getEventById(
                        oldEvent.id
                    );
                    const didModify = await this.plugin.cache.updateEventWithId(
                        oldEvent.id,
                        fromEventApi(newEvent, existing)
                    );
                    return !!didModify;
                } catch (e: any) {
                    console.error(e);
                    new Notice(e.message);
                    return false;
                }
            },

            eventMouseEnter: async (info) => {
                try {
                    // Any event backed by a note gets native page preview,
                    // including read-only ones.
                    const location = this.plugin.cache.getInfoForEvent(
                        info.event.id
                    ).location;
                    if (location) {
                        this.app.workspace.trigger("hover-link", {
                            event: info.jsEvent,
                            source: PLUGIN_SLUG,
                            hoverParent: calendarEl,
                            targetEl: info.jsEvent.target,
                            linktext: location.path,
                            sourcePath: location.path,
                        });
                    }
                } catch (e) {}
            },
            firstDay: this.plugin.settings.firstDay,
            initialView: this.plugin.settings.initialView,
            timeFormat24h: this.plugin.settings.timeFormat24h,
            openContextMenuForEvent: async (e, mouseEvent) => {
                const menu = new Menu();
                if (!this.plugin.cache) {
                    return;
                }
                const event = this.plugin.cache.getEventById(e.id);
                if (!event) {
                    return;
                }

                if (this.plugin.cache.isEventEditable(e.id)) {
                    if (!isTask(event)) {
                        menu.addItem((item) =>
                            item
                                .setTitle("Turn into task")
                                .onClick(async () => {
                                    await this.plugin.cache.processEvent(
                                        e.id,
                                        (e) => toggleTask(e, false)
                                    );
                                })
                        );
                    } else {
                        menu.addItem((item) =>
                            item
                                .setTitle("Remove checkbox")
                                .onClick(async () => {
                                    await this.plugin.cache.processEvent(
                                        e.id,
                                        unmakeTask
                                    );
                                })
                        );
                    }
                    menu.addSeparator();
                    menu.addItem((item) =>
                        item.setTitle("Go to note").onClick(() => {
                            if (!this.plugin.cache) {
                                return;
                            }
                            openFileForEvent(this.plugin.cache, this.app, e.id);
                        })
                    );
                    menu.addItem((item) =>
                        item.setTitle("Delete").onClick(async () => {
                            if (!this.plugin.cache) {
                                return;
                            }
                            try {
                                await deleteEventWithScope(
                                    this.plugin.cache,
                                    this.app,
                                    e.id,
                                    e.start ? occurrenceDate(e.start) : null
                                );
                            } catch (err) {
                                console.error(err);
                                if (err instanceof Error) {
                                    new Notice(err.message);
                                }
                            }
                        })
                    );
                } else if (this.plugin.cache.getNotePathForEvent(e.id)) {
                    // Read-only, but sourced from a note: the only thing on
                    // offer is opening it. No delete — the note is not the
                    // plugin's to remove, whatever the calendar shows.
                    menu.addItem((item) =>
                        item.setTitle("Go to note").onClick(() => {
                            openFileForEvent(this.plugin.cache, this.app, e.id);
                        })
                    );
                } else {
                    menu.addItem((item) => {
                        item.setTitle(
                            "No actions available on remote events"
                        ).setDisabled(true);
                    });
                }

                menu.showAtMouseEvent(mouseEvent);
            },
            toggleTask: async (e, isDone) => {
                const event = this.plugin.cache.getEventById(e.id);
                if (!event) {
                    return false;
                }
                if (event.type !== "single") {
                    return false;
                }

                try {
                    await this.plugin.cache.updateEventWithId(
                        e.id,
                        toggleTask(event, isDone)
                    );
                } catch (e) {
                    if (e instanceof FCError) {
                        new Notice(e.message);
                    }
                    return false;
                }
                return true;
            },
        });
        // @ts-ignore
        window.fc = this.fullCalendarView;

        await this.renderKey(keyEl);

        this.registerDomEvent(this.containerEl, "mouseenter", () => {
            this.plugin.cache.revalidateRemoteCalendars();
        });

        if (this.callback) {
            this.plugin.cache.off("update", this.callback);
            this.callback = null;
        }
        this.callback = this.plugin.cache.on("update", (payload) => {
            if (payload.type === "resync") {
                this.fullCalendarView?.removeAllEventSources();
                const sources = this.translateSources();
                sources.forEach((source) =>
                    this.fullCalendarView?.addEventSource(source)
                );
                // A resync is the only signal that the set of calendars itself
                // may have changed, so the key has to be rebuilt alongside the
                // event sources — otherwise a calendar added or removed in
                // settings leaves a stale row, or none at all.
                this.refreshKey();
                return;
            } else if (payload.type === "events") {
                const { toRemove, toAdd } = payload;
                console.debug("updating view from cache...", {
                    toRemove,
                    toAdd,
                });
                toRemove.forEach((id) => {
                    const event = this.fullCalendarView?.getEventById(id);
                    if (event) {
                        console.debug("removing event", event.toPlainObject());
                        event.remove();
                    } else {
                        console.warn(
                            `Event with id=${id} was slated to be removed but does not exist in the calendar.`
                        );
                    }
                });
                toAdd.forEach(({ id, event, calendarId }) => {
                    // A hidden calendar has no event source to attach to.
                    if (!this.isVisible(calendarId)) {
                        return;
                    }
                    const eventInput = toEventInput(
                        id,
                        event,
                        this.plugin.cache.overriddenOccurrences().get(id)
                    );
                    console.debug("adding event", {
                        id,
                        event,
                        eventInput,
                        calendarId,
                    });
                    const addedEvent = this.fullCalendarView?.addEvent(
                        eventInput!,
                        calendarId
                    );
                    console.debug("event that was added", addedEvent);
                });
            } else if (payload.type == "calendar") {
                const { calendar } = payload;
                console.debug("replacing calendar with id", calendar);
                this.fullCalendarView
                    ?.getEventSourceById(calendar.id)
                    ?.remove();
                // Re-adding a hidden calendar here would undo the toggle: this
                // fires whenever a remote calendar revalidates.
                if (this.isVisible(calendar.id)) {
                    this.fullCalendarView?.addEventSource(
                        this.translateSource(calendar)
                    );
                }
            }
        });
    }

    onResize(): void {
        if (this.fullCalendarView) {
            this.fullCalendarView.render();
        }
    }

    async onunload() {
        this.keyEl = null;
        if (this.fullCalendarView) {
            this.fullCalendarView.destroy();
            this.fullCalendarView = null;
        }
        if (this.callback) {
            this.plugin.cache.off("update", this.callback);
            this.callback = null;
        }
    }
}
