import * as React from "react";
import { useMemo, useState } from "react";
import { CalendarInfo, safeParseCalendarInfo } from "../../types";
import { MappingReport } from "../../calendars/parsing/derived";
import {
    DerivedDraft,
    DerivedMappingForm,
    MappingPreview,
} from "./DerivedCalendarSource";

type ChangeListener = <T extends Partial<CalendarInfo>>(
    fromString: (val: string) => T
) => React.ChangeEventHandler<HTMLInputElement | HTMLSelectElement>;
type SourceWith<T extends Partial<CalendarInfo>, K> = T extends K ? T : never;

interface DirectorySelectProps<T extends Partial<CalendarInfo>> {
    source: T;
    changeListener: ChangeListener;
    directories: string[];
}

function DirectorySelect<T extends Partial<CalendarInfo>>({
    source,
    changeListener,
    directories,
}: DirectorySelectProps<T>) {
    const dirOptions = [...directories];
    dirOptions.sort();

    let sourceWithDirectory = source as SourceWith<T, { directory: undefined }>;
    return (
        <div className="setting-item">
            <div className="setting-item-info">
                <div className="setting-item-name">Directory</div>
                <div className="setting-item-description">
                    Directory to store events
                </div>
            </div>
            <div className="setting-item-control">
                <select
                    required
                    value={sourceWithDirectory.directory || ""}
                    onChange={changeListener((x) => ({
                        ...sourceWithDirectory,
                        directory: x,
                    }))}
                >
                    <option value="" disabled hidden>
                        Choose a directory
                    </option>
                    {dirOptions.map((o, idx) => (
                        <option key={idx} value={o}>
                            {o}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );
}

interface BasicProps<T extends Partial<CalendarInfo>> {
    source: T;
    changeListener: ChangeListener;
}

function ColorPicker<T extends Partial<CalendarInfo>>({
    source,
    changeListener,
}: BasicProps<T>) {
    return (
        <div className="setting-item">
            <div className="setting-item-info">
                <div className="setting-item-name">Color</div>
                <div className="setting-item-description">
                    The color of events on the calendar
                </div>
            </div>
            <div className="setting-item-control">
                <input
                    required
                    type="color"
                    value={source.color}
                    style={{ maxWidth: "25%", minWidth: "3rem" }}
                    onChange={changeListener((x) => ({ ...source, color: x }))}
                />
            </div>
        </div>
    );
}

function UrlInput<T extends Partial<CalendarInfo>>({
    source,
    changeListener,
}: BasicProps<T>) {
    let sourceWithUrl = source as SourceWith<T, { url: undefined }>;
    return (
        <div className="setting-item">
            <div className="setting-item-info">
                <div className="setting-item-name">Url</div>
                <div className="setting-item-description">
                    Url of the server
                </div>
            </div>
            <div className="setting-item-control">
                <input
                    required
                    type="text"
                    value={sourceWithUrl.url || ""}
                    onChange={changeListener((x) => ({
                        ...sourceWithUrl,
                        url: x,
                    }))}
                />
            </div>
        </div>
    );
}

function UsernameInput<T extends Partial<CalendarInfo>>({
    source,
    changeListener,
}: BasicProps<T>) {
    let sourceWithUsername = source as SourceWith<T, { username: undefined }>;
    return (
        <div className="setting-item">
            <div className="setting-item-info">
                <div className="setting-item-name">Username</div>
                <div className="setting-item-description">
                    Username for the account
                </div>
            </div>
            <div className="setting-item-control">
                <input
                    required
                    type="text"
                    value={sourceWithUsername.username || ""}
                    onChange={changeListener((x) => ({
                        ...sourceWithUsername,
                        username: x,
                    }))}
                />
            </div>
        </div>
    );
}

function HeadingInput<T extends Partial<CalendarInfo>>({
    source,
    changeListener,
    headings,
}: BasicProps<T> & { headings: string[] }) {
    let sourceWithHeading = source as SourceWith<T, { heading: undefined }>;
    return (
        <div className="setting-item">
            <div className="setting-item-info">
                <div className="setting-item-name">Heading</div>
                <div className="setting-item-description">
                    Heading to store events under in the daily note.
                </div>
            </div>
            <div className="setting-item-control">
                {headings.length > 0 ? (
                    <select
                        required
                        value={sourceWithHeading.heading || ""}
                        onChange={changeListener((x) => ({
                            ...sourceWithHeading,
                            heading: x,
                        }))}
                    >
                        <option value="" disabled hidden>
                            Choose a heading
                        </option>
                        {headings.map((o, idx) => (
                            <option key={idx} value={o}>
                                {o}
                            </option>
                        ))}
                    </select>
                ) : (
                    <input
                        required
                        type="text"
                        value={sourceWithHeading.heading || ""}
                        onChange={changeListener((x) => ({
                            ...sourceWithHeading,
                            heading: x,
                        }))}
                    />
                )}
            </div>
        </div>
    );
}

function PasswordInput<T extends Partial<CalendarInfo>>({
    source,
    changeListener,
}: BasicProps<T>) {
    let sourceWithPassword = source as SourceWith<T, { password: undefined }>;
    return (
        <div className="setting-item">
            <div className="setting-item-info">
                <div className="setting-item-name">Password</div>
                <div className="setting-item-description">
                    Password for the account
                </div>
            </div>
            <div className="setting-item-control">
                <input
                    required
                    type="password"
                    value={sourceWithPassword.password || ""}
                    onChange={changeListener((x) => ({
                        ...sourceWithPassword,
                        password: x,
                    }))}
                />
            </div>
        </div>
    );
}

interface AddCalendarProps {
    source: Partial<CalendarInfo>;
    /** Every folder in the vault. */
    directories: string[];
    /** Folders already backing an editable calendar, which may not be reused. */
    usedDirectories: string[];
    headings: string[];
    /** Frontmatter properties present in a folder, for the mapping form. */
    listProperties: (directory: string, recursive: boolean) => string[];
    /** What a draft mapping would make of its folder. */
    previewDerived: (draft: DerivedDraft) => {
        report: MappingReport | null;
        error: string | null;
    };
    submit: (source: CalendarInfo) => Promise<void>;
}

export const AddCalendarSource = ({
    source,
    directories,
    usedDirectories,
    headings,
    listProperties,
    previewDerived,
    submit,
}: AddCalendarProps) => {
    const isCalDAV = source.type === "caldav";
    const isDerived = source.type === "derived";

    const [setting, setSettingState] = useState(source);
    const [submitting, setSubmitingState] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [submitText, setSubmitText] = useState(
        isCalDAV ? "Import Calendars" : "Add Calendar"
    );

    function makeChangeListener<T extends Partial<CalendarInfo>>(
        fromString: (val: string) => T
    ): React.ChangeEventHandler<HTMLInputElement | HTMLSelectElement> {
        return (e) => setSettingState(fromString(e.target.value));
    }

    const draft = setting as DerivedDraft;

    // Both of these walk the chosen folder, so they are recomputed only when
    // something they actually depend on changes — not on every keystroke
    // elsewhere in the form.
    const properties = useMemo(
        () =>
            isDerived && draft.directory
                ? listProperties(draft.directory, !!draft.recursive)
                : [],
        [isDerived, draft.directory, draft.recursive]
    );

    const preview = useMemo(
        () =>
            isDerived
                ? previewDerived(draft)
                : { report: null, error: null as string | null },
        [isDerived, draft]
    );

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (submitting) {
            return;
        }
        // A derived source has a nested mapping that no amount of `required`
        // on the inputs fully covers, so it is checked against the schema that
        // will have to load it back from data.json.
        if (isDerived && !safeParseCalendarInfo(setting)) {
            setError(
                "This mapping is incomplete: check that the name, directory and start date property are all filled in."
            );
            return;
        }
        setError(null);
        setSubmitingState(true);
        setSubmitText(isCalDAV ? "Importing Calendars" : "Adding Calendar");
        await submit(setting as CalendarInfo);
    };

    return (
        <div className="vertical-tab-content">
            <form onSubmit={handleSubmit}>
                {!isCalDAV && (
                    // CalDAV can import multiple calendars. Instead of picking
                    // a single color to be used for all calendars, default to the
                    // colors reported from the server. Users can change that later
                    // if they wish.
                    <ColorPicker
                        source={setting}
                        changeListener={makeChangeListener}
                    />
                )}
                {source.type === "local" && (
                    <DirectorySelect
                        source={setting}
                        changeListener={makeChangeListener}
                        // An editable calendar owns its directory; two of them
                        // sharing one would fight over the same notes.
                        directories={directories.filter(
                            (dir) => !usedDirectories.includes(dir)
                        )}
                    />
                )}
                {isDerived && (
                    <>
                        <DerivedMappingForm
                            draft={draft}
                            setDraft={setSettingState}
                            // Deliberately unfiltered: a derived calendar only
                            // reads, so several may share a folder — and may
                            // share one with an editable calendar too.
                            directories={directories}
                            properties={properties}
                        />
                        <MappingPreview
                            report={preview.report}
                            error={preview.error}
                        />
                    </>
                )}
                {source.type === "dailynote" && (
                    <HeadingInput
                        source={setting}
                        changeListener={makeChangeListener}
                        headings={headings}
                    />
                )}
                {source.type === "ical" || source.type === "caldav" ? (
                    <UrlInput
                        source={setting}
                        changeListener={makeChangeListener}
                    />
                ) : null}
                {isCalDAV && (
                    <UsernameInput
                        source={setting}
                        changeListener={makeChangeListener}
                    />
                )}
                {isCalDAV && (
                    <PasswordInput
                        source={setting}
                        changeListener={makeChangeListener}
                    />
                )}
                {error && (
                    <div className="setting-item">
                        <div className="setting-item-info">
                            <div className="setting-item-description">
                                {error}
                            </div>
                        </div>
                    </div>
                )}
                <div className="setting-item">
                    <div className="setting-item-info" />
                    <div className="setting-control">
                        <button
                            className="mod-cta"
                            type="submit"
                            disabled={submitting}
                        >
                            {submitText}
                        </button>
                    </div>
                </div>
            </form>
        </div>
    );
};
