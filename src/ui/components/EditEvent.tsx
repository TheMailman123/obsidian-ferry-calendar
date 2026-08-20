import { DateTime } from "luxon";
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { CalendarInfo, FerryEvent } from "../../types";
import { carryOverFields } from "../../types/schema";
import {
    FREQUENCIES,
    Frequency,
    isFrequency,
    RecurrenceSpec,
    Weekday,
    WEEKDAYS,
} from "../../calendars/recurrence";

function makeChangeListener<T>(
    setState: React.Dispatch<React.SetStateAction<T>>,
    fromString: (val: string) => T
): React.ChangeEventHandler<HTMLInputElement | HTMLSelectElement> {
    return (e) => setState(fromString(e.target.value));
}

interface DayChoiceProps {
    code: Weekday;
    label: string;
    isSelected: boolean;
    onClick: (code: Weekday) => void;
}
const DayChoice = ({ code, label, isSelected, onClick }: DayChoiceProps) => (
    <button
        type="button"
        style={{
            marginLeft: "0.25rem",
            marginRight: "0.25rem",
            padding: "0",
            backgroundColor: isSelected
                ? "var(--interactive-accent)"
                : "var(--interactive-normal)",
            color: isSelected ? "var(--text-on-accent)" : "var(--text-normal)",
            borderStyle: "solid",
            borderWidth: "1px",
            borderRadius: "50%",
            width: "25px",
            height: "25px",
        }}
        onClick={() => onClick(code)}
    >
        <b>{label[0]}</b>
    </button>
);

/**
 * The weekday buttons, in the order a calendar reads.
 *
 * Keyed by the RFC 5545 codes the authored rule is written in, so the row hands
 * back a `byDay` directly rather than through a translation.
 */
const DAY_MAP: Record<Weekday, string> = {
    SU: "Sunday",
    MO: "Monday",
    TU: "Tuesday",
    WE: "Wednesday",
    TH: "Thursday",
    FR: "Friday",
    SA: "Saturday",
};

/** Weekday buttons run Sunday-first, as the row has always been drawn. */
const WEEKDAY_ORDER: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** How a series is described as ending, which is the choice the user makes. */
type EndMode = "never" | "count" | "until";

/**
 * Which ending a rule describes.
 *
 * `count` and `until` are mutually exclusive in the rule and in the form, so
 * the radio group is the single place that decides between them.
 */
function endModeOf(spec: RecurrenceSpec | undefined): EndMode {
    if (spec?.count !== undefined) {
        return "count";
    }
    if (spec?.until !== undefined) {
        return "until";
    }
    return "never";
}

const DaySelect = ({
    value: days,
    onChange,
}: {
    value: Weekday[];
    onChange: (days: Weekday[]) => void;
}) => {
    return (
        <div>
            {WEEKDAY_ORDER.map((code) => (
                <DayChoice
                    key={code}
                    code={code}
                    label={DAY_MAP[code]}
                    isSelected={days.includes(code)}
                    onClick={() =>
                        days.includes(code)
                            ? onChange(days.filter((c) => c !== code))
                            : onChange([code, ...days])
                    }
                />
            ))}
        </div>
    );
};

interface EditEventProps {
    submit: (frontmatter: FerryEvent, calendarIndex: number) => Promise<void>;
    readonly calendars: {
        id: string;
        name: string;
        type: CalendarInfo["type"];
    }[];
    defaultCalendarIndex: number;
    initialEvent?: Partial<FerryEvent>;
    open?: () => Promise<void>;
    deleteEvent?: () => Promise<void>;
}

export const EditEvent = ({
    initialEvent,
    submit,
    open,
    deleteEvent,
    calendars,
    defaultCalendarIndex,
}: EditEventProps) => {
    // The event being edited may be half-built — the modal is opened on a
    // selection as well as on an existing note — so the rule is read once and
    // every field below defaults from it rather than re-narrowing the union.
    const initialRecurrence =
        initialEvent?.type === "recurring" ? initialEvent.recurring : undefined;

    const [date, setDate] = useState(
        initialEvent
            ? initialEvent.type === "single"
                ? initialEvent.date
                : initialEvent.type === "recurring"
                ? initialRecurrence?.start ?? ""
                : initialEvent.type === "rrule"
                ? initialEvent.startDate
                : ""
            : ""
    );
    const [endDate, setEndDate] = useState(
        initialEvent && initialEvent.type === "single"
            ? initialEvent.endDate
            : undefined
    );

    let initialStartTime = "";
    let initialEndTime = "";
    if (initialEvent) {
        // @ts-ignore
        const { startTime, endTime } = initialEvent;
        initialStartTime = startTime || "";
        initialEndTime = endTime || "";
    }

    const [startTime, setStartTime] = useState(initialStartTime);
    const [endTime, setEndTime] = useState(initialEndTime);
    const [title, setTitle] = useState(initialEvent?.title || "");
    const [isRecurring, setIsRecurring] = useState(
        initialEvent?.type === "recurring" || false
    );
    const [freq, setFreq] = useState<Frequency>(
        initialRecurrence?.freq ?? "weekly"
    );
    const [interval, setInterval] = useState(initialRecurrence?.interval ?? 1);
    const [byDay, setByDay] = useState<Weekday[]>(
        initialRecurrence?.byDay ?? []
    );
    const [endMode, setEndMode] = useState<EndMode>(
        endModeOf(initialRecurrence)
    );
    const [count, setCount] = useState(initialRecurrence?.count ?? 10);
    const [endRecur, setEndRecur] = useState(initialRecurrence?.until ?? "");

    // A rule written by hand in the note, which the structured fields cannot
    // say. It is carried through untouched rather than edited here: rewriting
    // `FREQ=MONTHLY;BYDAY=3FR` as whatever the form happens to hold would throw
    // away the rule the user went to the trouble of writing.
    const customRule = initialRecurrence?.rrule;

    const [allDay, setAllDay] = useState(initialEvent?.allDay || false);

    const [calendarIndex, setCalendarIndex] = useState(defaultCalendarIndex);

    const [complete, setComplete] = useState(
        initialEvent?.type === "single" &&
            initialEvent.completed !== null &&
            initialEvent.completed !== undefined
            ? initialEvent.completed
            : false
    );

    const [isTask, setIsTask] = useState(
        initialEvent?.type === "single" &&
            initialEvent.completed !== undefined &&
            initialEvent.completed !== null
    );

    const titleRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (titleRef.current) {
            titleRef.current.focus();
        }
    }, [titleRef]);

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        await submit(
            {
                // Same reason as the drag path: a form knows what is in its
                // inputs and nothing else, so the note's own fields are carried
                // rather than rebuilt. See `carryOverFields`.
                ...carryOverFields(
                    initialEvent,
                    isRecurring ? "recurring" : "single"
                ),
                ...{ title },
                ...(allDay
                    ? { allDay: true }
                    : { allDay: false, startTime: startTime || "", endTime }),
                ...(isRecurring
                    ? {
                          type: "recurring",
                          recurring: {
                              // DTSTART is mandatory — a series with no
                              // beginning has no occurrences — and the form
                              // requires the field for the same reason.
                              start: date || "",
                              ...(customRule !== undefined
                                  ? { rrule: customRule }
                                  : {
                                        freq,
                                        // An interval of 1 is the default, so
                                        // writing it would only add a line to
                                        // the note that says nothing.
                                        ...(interval !== 1 ? { interval } : {}),
                                        ...(freq === "weekly" &&
                                        byDay.length > 0
                                            ? { byDay }
                                            : {}),
                                        ...(endMode === "count"
                                            ? { count }
                                            : {}),
                                        ...(endMode === "until"
                                            ? { until: endRecur }
                                            : {}),
                                    }),
                          },
                      }
                    : {
                          type: "single",
                          date: date || "",
                          endDate: endDate || null,
                          completed: isTask ? complete : null,
                      }),
            },
            calendarIndex
        );
    };

    return (
        <>
            <div>
                <p style={{ float: "right" }}>
                    {open && <button onClick={open}>Open Note</button>}
                </p>
            </div>

            <form onSubmit={handleSubmit}>
                <p>
                    <input
                        ref={titleRef}
                        type="text"
                        id="title"
                        value={title}
                        placeholder={"Add title"}
                        required
                        onChange={makeChangeListener(setTitle, (x) => x)}
                    />
                </p>
                <p>
                    <select
                        id="calendar"
                        value={calendarIndex}
                        onChange={makeChangeListener(
                            setCalendarIndex,
                            parseInt
                        )}
                    >
                        {calendars
                            .flatMap((cal) =>
                                cal.type === "local" || cal.type === "dailynote"
                                    ? [cal]
                                    : []
                            )
                            .map((cal, idx) => (
                                <option
                                    key={idx}
                                    value={idx}
                                    disabled={
                                        !(
                                            initialEvent?.title === undefined ||
                                            calendars[calendarIndex].type ===
                                                cal.type
                                        )
                                    }
                                >
                                    {cal.type === "local"
                                        ? cal.name
                                        : "Daily Note"}
                                </option>
                            ))}
                    </select>
                </p>
                <p>
                    {!isRecurring && (
                        <input
                            type="date"
                            id="date"
                            value={date}
                            required
                            // @ts-ignore
                            onChange={makeChangeListener(setDate, (x) => x)}
                        />
                    )}

                    {allDay ? (
                        <></>
                    ) : (
                        <>
                            <input
                                type="time"
                                id="startTime"
                                value={startTime}
                                required
                                onChange={makeChangeListener(
                                    setStartTime,
                                    (x) => x
                                )}
                            />
                            -
                            <input
                                type="time"
                                id="endTime"
                                value={endTime}
                                required
                                onChange={makeChangeListener(
                                    setEndTime,
                                    (x) => x
                                )}
                            />
                        </>
                    )}
                </p>
                <p>
                    <label htmlFor="allDay">All day event </label>
                    <input
                        id="allDay"
                        checked={allDay}
                        onChange={(e) => setAllDay(e.target.checked)}
                        type="checkbox"
                    />
                </p>
                <p>
                    <label htmlFor="recurring">Recurring Event </label>
                    <input
                        id="recurring"
                        checked={isRecurring}
                        onChange={(e) => setIsRecurring(e.target.checked)}
                        type="checkbox"
                    />
                </p>

                {isRecurring && (
                    <>
                        <p>
                            <label htmlFor="startDate">Starts on </label>
                            <input
                                type="date"
                                id="startDate"
                                value={date}
                                required
                                // @ts-ignore
                                onChange={makeChangeListener(setDate, (x) => x)}
                            />
                        </p>

                        {customRule !== undefined ? (
                            <p>
                                Repeats by the rule <code>{customRule}</code>,
                                which is edited in the note itself.
                            </p>
                        ) : (
                            <>
                                <p>
                                    <label htmlFor="interval">
                                        Repeats every{" "}
                                    </label>
                                    <input
                                        type="number"
                                        id="interval"
                                        min={1}
                                        value={interval}
                                        style={{ width: "4rem" }}
                                        onChange={makeChangeListener(
                                            setInterval,
                                            (x) => Number(x)
                                        )}
                                    />
                                    <select
                                        id="freq"
                                        value={freq}
                                        onChange={makeChangeListener(
                                            setFreq,
                                            (x) =>
                                                isFrequency(x) ? x : "weekly"
                                        )}
                                    >
                                        {FREQUENCIES.map((f) => (
                                            <option key={f} value={f}>
                                                {f === "daily"
                                                    ? "day"
                                                    : f === "weekly"
                                                    ? "week"
                                                    : f === "monthly"
                                                    ? "month"
                                                    : "year"}
                                                {interval === 1 ? "" : "s"}
                                            </option>
                                        ))}
                                    </select>
                                </p>

                                {freq === "weekly" && (
                                    <DaySelect
                                        value={byDay}
                                        onChange={setByDay}
                                    />
                                )}

                                <p>
                                    <label>Ends </label>
                                    <label htmlFor="endNever">
                                        <input
                                            type="radio"
                                            id="endNever"
                                            name="endMode"
                                            checked={endMode === "never"}
                                            onChange={() => setEndMode("never")}
                                        />
                                        never
                                    </label>
                                    <label htmlFor="endCount">
                                        <input
                                            type="radio"
                                            id="endCount"
                                            name="endMode"
                                            checked={endMode === "count"}
                                            onChange={() => setEndMode("count")}
                                        />
                                        after
                                    </label>
                                    <input
                                        type="number"
                                        id="count"
                                        min={1}
                                        value={count}
                                        disabled={endMode !== "count"}
                                        required={endMode === "count"}
                                        style={{ width: "4rem" }}
                                        onChange={makeChangeListener(
                                            setCount,
                                            (x) => Number(x)
                                        )}
                                    />
                                    times
                                    <label htmlFor="endUntil">
                                        <input
                                            type="radio"
                                            id="endUntil"
                                            name="endMode"
                                            checked={endMode === "until"}
                                            onChange={() => setEndMode("until")}
                                        />
                                        on
                                    </label>
                                    <input
                                        type="date"
                                        id="endDate"
                                        value={endRecur}
                                        disabled={endMode !== "until"}
                                        required={endMode === "until"}
                                        onChange={makeChangeListener(
                                            setEndRecur,
                                            (x) => x
                                        )}
                                    />
                                </p>
                            </>
                        )}
                    </>
                )}
                <p>
                    <label htmlFor="task">Task Event </label>
                    <input
                        id="task"
                        checked={isTask}
                        onChange={(e) => {
                            setIsTask(e.target.checked);
                        }}
                        type="checkbox"
                    />
                </p>

                {isTask && (
                    <>
                        <label htmlFor="taskStatus">Complete? </label>
                        <input
                            id="taskStatus"
                            checked={
                                !(complete === false || complete === undefined)
                            }
                            onChange={(e) =>
                                setComplete(
                                    e.target.checked
                                        ? DateTime.now().toISO()
                                        : false
                                )
                            }
                            type="checkbox"
                        />
                    </>
                )}

                <p
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        width: "100%",
                    }}
                >
                    <button type="submit"> Save Event </button>
                    <span>
                        {deleteEvent && (
                            <button
                                type="button"
                                style={{
                                    backgroundColor:
                                        "var(--interactive-normal)",
                                    color: "var(--background-modifier-error)",
                                    borderColor:
                                        "var(--background-modifier-error)",
                                    borderWidth: "1px",
                                    borderStyle: "solid",
                                }}
                                onClick={deleteEvent}
                            >
                                Delete Event
                            </button>
                        )}
                    </span>
                </p>
            </form>
        </>
    );
};
