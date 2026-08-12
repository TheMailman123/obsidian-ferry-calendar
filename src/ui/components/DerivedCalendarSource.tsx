import * as React from "react";
import { CalendarInfo } from "../../types";
import {
    DerivedFilter,
    DerivedMapping,
    MappingReport,
} from "../../calendars/parsing/derived";

/*
 * The "add custom directory" form: pick a folder, describe how its frontmatter
 * becomes an event, see what that would produce before saving.
 *
 * Every field here maps onto the mapping config and nothing else — there is no
 * per-folder special casing to configure, because the plugin has none.
 */

export type DerivedSource = Extract<CalendarInfo, { type: "derived" }>;

/** A derived source part-way through being filled in. */
export type DerivedDraft = Partial<Omit<DerivedSource, "mapping">> & {
    type: "derived";
    mapping: DerivedMapping;
};

interface FieldProps {
    name: string;
    description?: string;
    children: React.ReactNode;
}

function Field({ name, description, children }: FieldProps) {
    return (
        <div className="setting-item">
            <div className="setting-item-info">
                <div className="setting-item-name">{name}</div>
                {description && (
                    <div className="setting-item-description">
                        {description}
                    </div>
                )}
            </div>
            <div className="setting-item-control">{children}</div>
        </div>
    );
}

/** Id of the single datalist every property input in the form shares. */
const PROPERTY_LIST_ID = "ferry-derived-properties";

interface PropertyInputProps {
    value: string | undefined;
    onChange: (value: string) => void;
    required?: boolean;
}

/**
 * A frontmatter property name.
 *
 * Free text backed by a datalist of the properties actually present in the
 * chosen folder: the notes are the authority on what they are called, and
 * typing a name from memory is how a mapping ends up silently matching
 * nothing. Still free text, since the folder may be empty or about to grow.
 */
function PropertyInput({ value, onChange, required }: PropertyInputProps) {
    return (
        <input
            type="text"
            required={required}
            value={value ?? ""}
            list={PROPERTY_LIST_ID}
            placeholder="property name"
            onChange={(e) => onChange(e.target.value)}
        />
    );
}

const FILTER_OPS: { value: DerivedFilter["op"] | "none"; label: string }[] = [
    { value: "none", label: "Include every note" },
    { value: "exists", label: "Only notes where property is set" },
    { value: "missing", label: "Only notes where property is not set" },
    { value: "equals", label: "Only notes where property equals" },
    { value: "notEquals", label: "Only notes where property does not equal" },
];

interface MappingFormProps {
    draft: DerivedDraft;
    setDraft: (draft: DerivedDraft) => void;
    directories: string[];
    properties: string[];
}

export function DerivedMappingForm({
    draft,
    setDraft,
    directories,
    properties,
}: MappingFormProps) {
    const { mapping } = draft;

    const setMapping = (changes: Partial<DerivedMapping>) =>
        setDraft({ ...draft, mapping: { ...mapping, ...changes } });

    // The three-way allDay control: a literal yes/no, or read per note from a
    // property. Kept as one control because the config field is one field.
    const allDayMode =
        typeof mapping.allDay === "string"
            ? "property"
            : String(mapping.allDay);

    const repeatMode = ["none", "yearly", "monthly"].includes(
        mapping.repeat.toLowerCase()
    )
        ? mapping.repeat.toLowerCase()
        : "custom";

    const filterOp = draft.mapping.filter?.op ?? "none";

    const setFilter = (changes: Partial<DerivedFilter>) => {
        const current: DerivedFilter = mapping.filter ?? {
            property: "",
            op: "exists",
        };
        setMapping({ filter: { ...current, ...changes } });
    };

    const dirOptions = [...directories].sort();

    return (
        <>
            {/* One list, shared by every property input below. */}
            <datalist id={PROPERTY_LIST_ID}>
                {properties.map((p) => (
                    <option key={p} value={p} />
                ))}
            </datalist>

            <Field
                name="Name"
                description="What this calendar is called in the calendar key."
            >
                <input
                    required
                    type="text"
                    value={draft.name ?? ""}
                    onChange={(e) =>
                        setDraft({ ...draft, name: e.target.value })
                    }
                />
            </Field>

            <Field
                name="Directory"
                description="Folder of notes to read. Nothing in it is ever modified."
            >
                <select
                    required
                    value={draft.directory ?? ""}
                    onChange={(e) =>
                        setDraft({ ...draft, directory: e.target.value })
                    }
                >
                    <option value="" disabled hidden>
                        Choose a directory
                    </option>
                    {dirOptions.map((o) => (
                        <option key={o} value={o}>
                            {o}
                        </option>
                    ))}
                </select>
            </Field>

            <Field name="Include subfolders">
                <input
                    type="checkbox"
                    checked={draft.recursive ?? false}
                    onChange={(e) =>
                        setDraft({ ...draft, recursive: e.target.checked })
                    }
                />
            </Field>

            <Field
                name="Title"
                description="Template. {{file.basename}}, {{file.path}} and {{property:NAME}}."
            >
                <input
                    required
                    type="text"
                    value={mapping.title}
                    onChange={(e) => setMapping({ title: e.target.value })}
                />
            </Field>

            <Field
                name="Start date property"
                description="Frontmatter property holding the date. May include a time."
            >
                <PropertyInput
                    required
                    value={mapping.start}
                    onChange={(start) => setMapping({ start })}
                />
            </Field>

            <Field
                name="End date property"
                description="Optional. The last day of the record; leave blank for single-day events."
            >
                <PropertyInput
                    value={mapping.end}
                    onChange={(end) => setMapping({ end: end || undefined })}
                />
            </Field>

            <Field
                name="All-day"
                description="Whether these records have times on them."
            >
                <select
                    value={allDayMode}
                    onChange={(e) => {
                        const mode = e.target.value;
                        setMapping({
                            allDay:
                                mode === "property"
                                    ? ""
                                    : mode === "true"
                                    ? true
                                    : false,
                        });
                    }}
                >
                    <option value="true">Always all-day</option>
                    <option value="false">Always timed</option>
                    <option value="property">Read from a property</option>
                </select>
            </Field>

            {allDayMode === "property" && (
                <Field name="All-day property">
                    <PropertyInput
                        value={String(mapping.allDay)}
                        onChange={(allDay) => setMapping({ allDay })}
                    />
                </Field>
            )}

            {allDayMode !== "true" && (
                <>
                    <Field
                        name="Start time property"
                        description="Optional. Only needed when the time is separate from the date."
                    >
                        <PropertyInput
                            value={mapping.startTime}
                            onChange={(startTime) =>
                                setMapping({
                                    startTime: startTime || undefined,
                                })
                            }
                        />
                    </Field>
                    <Field name="End time property" description="Optional.">
                        <PropertyInput
                            value={mapping.endTime}
                            onChange={(endTime) =>
                                setMapping({ endTime: endTime || undefined })
                            }
                        />
                    </Field>
                </>
            )}

            <Field
                name="Repeat"
                description="Projected at render. Nothing is ever written back to the note."
            >
                <select
                    value={repeatMode}
                    onChange={(e) => {
                        const mode = e.target.value;
                        setMapping({
                            repeat: mode === "custom" ? "FREQ=" : mode,
                        });
                    }}
                >
                    <option value="none">No repeat</option>
                    <option value="yearly">Yearly</option>
                    <option value="monthly">Monthly</option>
                    <option value="custom">Custom rule…</option>
                </select>
            </Field>

            {repeatMode === "custom" && (
                <Field name="Repeat rule" description="An RFC 5545 RRULE.">
                    <input
                        required
                        type="text"
                        value={mapping.repeat}
                        onChange={(e) => setMapping({ repeat: e.target.value })}
                    />
                </Field>
            )}

            <Field
                name="Date format"
                description="'iso' for 2024-05-04, or a format like dd/MM/yyyy."
            >
                <input
                    required
                    type="text"
                    value={mapping.dateFormat}
                    onChange={(e) => setMapping({ dateFormat: e.target.value })}
                />
            </Field>

            <Field
                name="Skip notes with no date"
                description="Off reports them instead, for a folder where every note should have one."
            >
                <input
                    type="checkbox"
                    checked={mapping.skipIfMissing}
                    onChange={(e) =>
                        setMapping({ skipIfMissing: e.target.checked })
                    }
                />
            </Field>

            <Field
                name="Filter"
                description="Optional. Which notes to include."
            >
                <select
                    value={filterOp}
                    onChange={(e) => {
                        const op = e.target.value;
                        if (op === "none") {
                            setMapping({ filter: undefined });
                            return;
                        }
                        setFilter({ op: op as DerivedFilter["op"] });
                    }}
                >
                    {FILTER_OPS.map(({ value, label }) => (
                        <option key={value} value={value}>
                            {label}
                        </option>
                    ))}
                </select>
            </Field>

            {mapping.filter && (
                <Field name="Filter property">
                    <PropertyInput
                        required
                        value={mapping.filter.property}
                        onChange={(property) => setFilter({ property })}
                    />
                    {(mapping.filter.op === "equals" ||
                        mapping.filter.op === "notEquals") && (
                        <input
                            type="text"
                            placeholder="value"
                            value={String(mapping.filter.value ?? "")}
                            onChange={(e) =>
                                setFilter({ value: e.target.value })
                            }
                        />
                    )}
                </Field>
            )}
        </>
    );
}

interface PreviewProps {
    report: MappingReport | null;
    error: string | null;
}

/**
 * What the mapping would make of the folder.
 *
 * The counts are the point: a generic mapper without them is a guessing game,
 * and a folder that silently yields nothing looks identical to one that is
 * working. Skips and errors are listed with their reasons rather than just
 * tallied, since the reason is what tells you which end to fix.
 */
export function MappingPreview({ report, error }: PreviewProps) {
    if (error) {
        return (
            <div className="setting-item">
                <div className="setting-item-info">
                    <div className="setting-item-name">Preview</div>
                    <div className="setting-item-description">{error}</div>
                </div>
            </div>
        );
    }

    if (!report) {
        return null;
    }

    return (
        <div className="setting-item" style={{ display: "block" }}>
            <div className="setting-item-name">
                {report.matched} matched, {report.skipped} skipped,{" "}
                {report.errors} could not be read
                {report.filtered > 0 && `, ${report.filtered} filtered out`}
            </div>
            <div className="setting-item-description">
                {report.samples.matched.length > 0 && (
                    <ul>
                        {report.samples.matched.map(({ path, title }) => (
                            <li key={path}>
                                <strong>{title}</strong> — {path}
                            </li>
                        ))}
                    </ul>
                )}
                {report.samples.skipped.length > 0 && (
                    <>
                        <div>Skipped, for example:</div>
                        <ul>
                            {report.samples.skipped.map(({ path, reason }) => (
                                <li key={path}>
                                    {path}: {reason}
                                </li>
                            ))}
                        </ul>
                    </>
                )}
                {report.samples.errors.length > 0 && (
                    <>
                        <div>Could not be read:</div>
                        <ul>
                            {report.samples.errors.map(({ path, reason }) => (
                                <li key={path}>
                                    {path}: {reason}
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </div>
        </div>
    );
}
