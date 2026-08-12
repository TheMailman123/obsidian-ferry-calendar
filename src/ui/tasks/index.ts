import { DateTime } from "luxon";
import { FerryEvent } from "src/types";

export const isTask = (e: FerryEvent) =>
    e.type === "single" && e.completed !== undefined && e.completed !== null;

export const unmakeTask = (event: FerryEvent): FerryEvent => {
    if (event.type !== "single") {
        return event;
    }
    return { ...event, completed: null };
};

export const toggleTask = (event: FerryEvent, isDone: boolean): FerryEvent => {
    if (event.type !== "single") {
        return event;
    }
    if (isDone) {
        return { ...event, completed: DateTime.now().toISO() };
    } else {
        return { ...event, completed: false };
    }
};
