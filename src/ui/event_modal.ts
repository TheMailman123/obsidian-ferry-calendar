import { Notice } from "obsidian";
import * as React from "react";
import { EditableCalendar } from "src/calendars/EditableCalendar";
import FerryCalendarPlugin from "src/main";
import { FerryEvent } from "src/types";
import { occurrenceAsSingle } from "src/calendars/recurrence_edit";
import {
    deleteEventWithScope,
    modifyEventWithScope,
    openFileForEvent,
} from "./actions";
import { EditEvent } from "./components/EditEvent";
import ReactModal from "./ReactModal";

export function launchCreateModal(
    plugin: FerryCalendarPlugin,
    partialEvent: Partial<FerryEvent>
) {
    const calendars = [...plugin.cache.calendars.entries()]
        .filter(([_, cal]) => cal instanceof EditableCalendar)
        .map(([id, cal]) => {
            return {
                id,
                type: cal.type,
                name: cal.name,
            };
        });
    new ReactModal(plugin.app, async (closeModal) =>
        React.createElement(EditEvent, {
            initialEvent: partialEvent,
            calendars,
            defaultCalendarIndex: 0,
            submit: async (data, calendarIndex, description) => {
                const calendarId = calendars[calendarIndex].id;
                try {
                    await plugin.cache.addEvent(calendarId, data, description);
                } catch (e) {
                    if (e instanceof Error) {
                        new Notice("Error when creating event: " + e.message);
                        console.error(e);
                    }
                }
                closeModal();
            },
        })
    ).open();
}

/**
 * Open the edit modal for an event.
 *
 * @param occurrence Date of the occurrence that was clicked, for a recurring
 * event, from `occurrenceDate`. The modal is opened on one occurrence of a
 * series but holds the whole series, so anything per-instance — deleting this
 * one, for now — needs telling which one that was. Null for an event that does
 * not repeat, and for callers with no occurrence in hand.
 */
export function launchEditModal(
    plugin: FerryCalendarPlugin,
    eventId: string,
    occurrence: string | null = null
) {
    const eventToEdit = plugin.cache.getEventById(eventId);
    if (!eventToEdit) {
        throw new Error("Cannot edit event that doesn't exist.");
    }
    const calId = plugin.cache.getInfoForEditableEvent(eventId).calendar.id;

    const calendars = [...plugin.cache.calendars.entries()]
        .filter(([_, cal]) => cal instanceof EditableCalendar)
        .map(([id, cal]) => {
            return {
                id,
                type: cal.type,
                name: cal.name,
            };
        });

    const calIdx = calendars.findIndex(({ id }) => id === calId);

    new ReactModal(plugin.app, async (closeModal) => {
        // Read here and nowhere else: the note's body is touched only when
        // somebody opens the modal on it. See PLANNING §13.6.
        const initialDescription = await plugin.cache.descriptionOf(eventId);
        return React.createElement(EditEvent, {
            initialEvent: eventToEdit,
            initialDescription,
            calendars,
            defaultCalendarIndex: calIdx,
            submit: async (data, calendarIndex, description) => {
                try {
                    if (calendarIndex !== calIdx) {
                        await plugin.cache.moveEventToCalendar(
                            eventId,
                            calendars[calendarIndex].id
                        );
                    }
                    // As with deleting: a dismissed prompt leaves the modal
                    // open, because the user has not finished with the event —
                    // they have declined to say how much of it to change.
                    const modified = await modifyEventWithScope(
                        plugin.cache,
                        plugin.app,
                        eventId,
                        occurrence,
                        {
                            series: () => data,
                            // The modal edits the series, so an edit meant for
                            // one occurrence has to be lifted out of the rule
                            // that generated it.
                            instance: (on) => occurrenceAsSingle(data, on),
                            // Unchanged text is still passed: the scope may
                            // send the edit to a note that does not have it
                            // yet — a fresh override, or the second half of a
                            // split series.
                            description,
                        }
                    );
                    if (!modified) {
                        return;
                    }
                } catch (e) {
                    if (e instanceof Error) {
                        new Notice("Error when updating event: " + e.message);
                        console.error(e);
                    }
                }
                closeModal();
            },
            open: async () => {
                openFileForEvent(plugin.cache, plugin.app, eventId);
            },
            deleteEvent: async () => {
                try {
                    // The modal stays open when the prompt is cancelled: the
                    // user has not finished with the event, they have declined
                    // to say how much of it to delete.
                    const deleted = await deleteEventWithScope(
                        plugin.cache,
                        plugin.app,
                        eventId,
                        occurrence
                    );
                    if (deleted) {
                        closeModal();
                    }
                } catch (e) {
                    if (e instanceof Error) {
                        new Notice("Error when deleting event: " + e.message);
                        console.error(e);
                    }
                }
            },
        });
    }).open();
}
