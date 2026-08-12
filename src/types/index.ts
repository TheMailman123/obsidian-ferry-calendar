import { CalendarInfo } from "./calendar_settings";

export type { FerryEvent } from "./schema";
export { validateEvent } from "./schema";

export {
    makeDefaultPartialCalendarSource,
    safeParseCalendarInfo,
} from "./calendar_settings";
export type { CalendarInfo } from "./calendar_settings";

export const PLUGIN_SLUG = "ferry-calendar";

export class FCError {
    message: string;
    constructor(message: string) {
        this.message = message;
    }
}

export type EventLocation = {
    file: { path: string };
    lineNumber: number | undefined;
};

export type Authentication = {
    type: "basic";
    username: string;
    password: string;
};

export type CalDAVSource = Extract<CalendarInfo, { type: "caldav" }>;
