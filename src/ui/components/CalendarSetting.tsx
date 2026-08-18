import { Notice } from "obsidian";
import * as React from "react";
import { SetStateAction, useState } from "react";

import { CalendarInfo } from "../../types";

type SourceWith<T extends Partial<CalendarInfo>, K> = T extends K ? T : never;

interface BasicProps<T extends Partial<CalendarInfo>> {
    source: T;
}

function DirectorySetting<T extends Partial<CalendarInfo>>({
    source,
}: BasicProps<T>) {
    let sourceWithDirectory = source as SourceWith<T, { directory: undefined }>;
    return (
        <div className="setting-item-control">
            <input
                disabled
                type="text"
                value={sourceWithDirectory.directory}
                style={{
                    width: "100%",
                    marginLeft: 4,
                    marginRight: 4,
                }}
            />
        </div>
    );
}

function HeadingSetting<T extends Partial<CalendarInfo>>({
    source,
}: BasicProps<T>) {
    let sourceWithHeading = source as SourceWith<T, { heading: undefined }>;
    return (
        <div
            className="setting-item-control"
            style={{ display: "block", textAlign: "center" }}
        >
            <span>Under heading</span>{" "}
            <input
                disabled
                type="text"
                value={sourceWithHeading.heading}
                style={{
                    marginLeft: 4,
                    marginRight: 4,
                }}
            />{" "}
            <span style={{ paddingRight: ".5rem" }}>in daily notes</span>
        </div>
    );
}

function UrlSetting<T extends Partial<CalendarInfo>>({
    source,
}: BasicProps<T>) {
    let sourceWithUrl = source as SourceWith<T, { url: undefined }>;
    return (
        <div className="setting-item-control">
            <input
                disabled
                type="text"
                value={sourceWithUrl.url}
                style={{
                    width: "100%",
                    marginLeft: 4,
                    marginRight: 4,
                }}
            />
        </div>
    );
}

function NameSetting<T extends Partial<CalendarInfo>>({
    source,
}: BasicProps<T>) {
    let sourceWithName = source as SourceWith<T, { name: undefined }>;
    return (
        <div className="setting-item-control">
            <input
                disabled
                type="text"
                value={sourceWithName.name}
                style={{
                    width: "100%",
                    marginLeft: 4,
                    marginRight: 4,
                }}
            />
        </div>
    );
}

/**
 * A derived calendar's row: its name and the folder it reads.
 *
 * Both are part of the calendar's identity — one folder can carry several
 * mappings — so neither is editable in place. Changing either means removing
 * the calendar and adding it back, which is also what keeps the stored
 * visibility toggles from stranding against an id that quietly changed.
 */
function DerivedSetting<T extends Partial<CalendarInfo>>({
    source,
}: BasicProps<T>) {
    const derived = source as SourceWith<
        T,
        { name: undefined; directory: undefined }
    >;
    return (
        <div className="setting-item-control" style={{ display: "block" }}>
            <input
                disabled
                type="text"
                value={derived.name}
                style={{ width: "100%", marginLeft: 4, marginRight: 4 }}
            />
            <span
                style={{ paddingLeft: 4, fontSize: "var(--font-ui-smaller)" }}
            >
                read-only, from {derived.directory}
            </span>
        </div>
    );
}

function Username<T extends Partial<CalendarInfo>>({ source }: BasicProps<T>) {
    let sourceWithUsername = source as SourceWith<T, { username: undefined }>;
    return (
        <div className="setting-item-control">
            <input
                disabled
                type="text"
                value={sourceWithUsername.username}
                style={{
                    width: "100%",
                    marginLeft: 4,
                    marginRight: 4,
                }}
            />
        </div>
    );
}

/**
 * Calendar types an ICS export can be produced for.
 *
 * Only the ones the plugin owns the notes of. An exported event needs a `uid`
 * written into its note to keep its identity across renames, and the plugin
 * writes nothing at all to a derived calendar's source notes — they exist for
 * other reasons and are read-only by design. Remote calendars are excluded for
 * the opposite reason: their events already come from a calendar server, and
 * exporting them back out would be a round trip to nowhere.
 */
const EXPORTABLE = ["local", "dailynote"];

/**
 * Whether this calendar is exported, and how long before an event to alert.
 *
 * Off by default and per calendar, which PLANNING §7.3 treats as a security
 * boundary: a file that syncs to a phone has left the vault, so it carries only
 * what was deliberately put in it.
 */
function ExportSetting({
    source,
    onExportChange,
}: {
    source: Partial<CalendarInfo>;
    onExportChange: (patch: Partial<CalendarInfo>) => void;
}) {
    const enabled = source.exportToICS ?? false;
    const minutes = source.reminderMinutes ?? 15;
    return (
        <div
            className="setting-item-control"
            style={{ display: "block", textAlign: "center" }}
        >
            <label style={{ fontSize: "var(--font-ui-smaller)" }}>
                <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) =>
                        onExportChange({ exportToICS: e.target.checked })
                    }
                />{" "}
                Export .ics
            </label>
            {enabled && (
                <span style={{ fontSize: "var(--font-ui-smaller)" }}>
                    {" "}
                    <input
                        type="number"
                        min={0}
                        value={minutes}
                        style={{ width: "4rem", marginLeft: 4 }}
                        onChange={(e) =>
                            onExportChange({
                                // An empty box means no alarm rather than zero
                                // minutes, which would alert as the event
                                // starts and read as a bug.
                                reminderMinutes:
                                    e.target.value === ""
                                        ? null
                                        : Number(e.target.value),
                            })
                        }
                    />{" "}
                    min before
                </span>
            )}
        </div>
    );
}

interface CalendarSettingsProps {
    setting: Partial<CalendarInfo>;
    onColorChange: (s: string) => void;
    onExportChange: (patch: Partial<CalendarInfo>) => void;
    deleteCalendar: () => void;
}

export const CalendarSettingRow = ({
    setting,
    onColorChange,
    onExportChange,
    deleteCalendar,
}: CalendarSettingsProps) => {
    const isCalDAV = setting.type === "caldav";
    return (
        <div className="setting-item">
            <button
                type="button"
                onClick={deleteCalendar}
                style={{ maxWidth: "15%" }}
            >
                ✕
            </button>
            {setting.type === "local" ? (
                <DirectorySetting source={setting} />
            ) : setting.type === "dailynote" ? (
                <HeadingSetting source={setting} />
            ) : setting.type === "derived" ? (
                <DerivedSetting source={setting} />
            ) : (
                <UrlSetting source={setting} />
            )}
            {isCalDAV && <NameSetting source={setting} />}
            {isCalDAV && <Username source={setting} />}
            {setting.type !== undefined &&
                EXPORTABLE.includes(setting.type) && (
                    <ExportSetting
                        source={setting}
                        onExportChange={onExportChange}
                    />
                )}
            <input
                style={{ maxWidth: "25%", minWidth: "3rem" }}
                type="color"
                value={setting.color}
                onChange={(e) => onColorChange(e.target.value)}
            />
        </div>
    );
};

interface CalendarSettingProps {
    sources: CalendarInfo[];
    submit: (payload: CalendarInfo[]) => void;
}
type CalendarSettingState = {
    sources: CalendarInfo[];
    dirty: boolean;
};
export class CalendarSettings extends React.Component<
    CalendarSettingProps,
    CalendarSettingState
> {
    constructor(props: CalendarSettingProps) {
        super(props);
        this.state = { sources: props.sources, dirty: false };
    }

    addSource(source: CalendarInfo) {
        this.setState((state, props) => ({
            sources: [...state.sources, source],
            dirty: true,
        }));
    }

    render() {
        return (
            <div style={{ width: "100%" }}>
                {this.state.sources.map((s, idx) => (
                    <CalendarSettingRow
                        key={idx}
                        setting={s}
                        onColorChange={(color) =>
                            this.setState((state, props) => ({
                                sources: [
                                    ...state.sources.slice(0, idx),
                                    { ...state.sources[idx], color },
                                    ...state.sources.slice(idx + 1),
                                ],
                                dirty: true,
                            }))
                        }
                        onExportChange={(patch) =>
                            this.setState((state) => ({
                                sources: [
                                    ...state.sources.slice(0, idx),
                                    {
                                        ...state.sources[idx],
                                        ...patch,
                                    } as CalendarInfo,
                                    ...state.sources.slice(idx + 1),
                                ],
                                dirty: true,
                            }))
                        }
                        deleteCalendar={() =>
                            this.setState((state, props) => ({
                                sources: [
                                    ...state.sources.slice(0, idx),
                                    ...state.sources.slice(idx + 1),
                                ],
                                dirty: true,
                            }))
                        }
                    />
                ))}
                <div className="setting-item-control">
                    {this.state.dirty && (
                        <button
                            onClick={() => {
                                if (
                                    this.state.sources.filter(
                                        (s) => s.type === "dailynote"
                                    ).length > 1
                                ) {
                                    new Notice(
                                        "Only one daily note calendar is allowed."
                                    );
                                    return;
                                }
                                this.props.submit(
                                    this.state.sources.map(
                                        (elt) => elt as CalendarInfo
                                    )
                                );
                                this.setState({ dirty: false });
                            }}
                            style={{
                                backgroundColor: this.state.dirty
                                    ? "var(--interactive-accent)"
                                    : undefined,
                                color: this.state.dirty
                                    ? "var(--text-on-accent)"
                                    : undefined,
                            }}
                        >
                            {this.state.dirty ? "Save" : "Settings Saved"}
                        </button>
                    )}
                </div>
            </div>
        );
    }
}
