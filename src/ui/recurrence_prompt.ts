import { App, Modal } from "obsidian";

/**
 * The "this event / this and following / all events" prompt.
 *
 * PLANNING §3.2 calls this non-negotiable, and it is: the per-instance data
 * model underneath it — skipDates, override notes, splitting a series on
 * `until` — is meaningless without a way for the user to say which of the three
 * they meant. Every drag, resize, edit and delete of a recurring instance comes
 * through here first.
 *
 * The modal is deliberately dumb, in the same way `FilenameRepairModal` is: it
 * is handed a title and answers with a choice. It knows nothing about events,
 * masters or the vault, and does no writing of its own.
 */

/** Which occurrences of a series an action applies to. */
export type RecurrenceScope = "this" | "following" | "all";

/** What the user is doing, which is all that changes in the wording. */
export type RecurrenceAction = "edit" | "delete";

/**
 * Button labels, in the order PLANNING §3.2 specifies them.
 *
 * The order matters more than it looks: "this event" is both the safest choice
 * and the most common one, so it leads and takes the default styling. "All
 * events" is the one that rewrites a rule the user may have spent time
 * authoring, so it sits furthest from the pointer's resting place.
 */
const SCOPE_LABELS: { scope: RecurrenceScope; label: string }[] = [
    { scope: "this", label: "This event" },
    { scope: "following", label: "This and following" },
    { scope: "all", label: "All events" },
];

class RecurrenceScopeModal extends Modal {
    private action: RecurrenceAction;
    private eventTitle: string;
    private resolve: (scope: RecurrenceScope | null) => void;
    /**
     * Whether a button was pressed, as opposed to the modal being dismissed.
     *
     * Every path out of a modal ends in `onClose`, including Escape and a click
     * on the background, and those have to answer null so a drag reverts rather
     * than silently applying to the whole series.
     */
    private chose = false;

    constructor(
        app: App,
        action: RecurrenceAction,
        eventTitle: string,
        resolve: (scope: RecurrenceScope | null) => void
    ) {
        super(app);
        this.action = action;
        this.eventTitle = eventTitle;
        this.resolve = resolve;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", {
            text:
                this.action === "delete"
                    ? "Delete recurring event"
                    : "Edit recurring event",
        });
        contentEl.createEl("p", {
            text: `"${
                this.eventTitle
            }" repeats. Which occurrences should this ${
                this.action === "delete" ? "delete" : "change"
            } apply to?`,
        });

        const buttons = contentEl.createDiv();
        buttons.style.display = "flex";
        buttons.style.gap = "0.5em";
        buttons.style.justifyContent = "flex-end";
        buttons.style.marginTop = "1em";
        buttons.style.flexWrap = "wrap";

        const cancel = buttons.createEl("button", { text: "Cancel" });
        cancel.addEventListener("click", () => this.close());

        for (const { scope, label } of SCOPE_LABELS) {
            const button = buttons.createEl("button", { text: label });
            if (scope === "this") {
                button.addClass("mod-cta");
            }
            button.addEventListener("click", () => {
                this.chose = true;
                this.resolve(scope);
                this.close();
            });
        }
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.chose) {
            this.resolve(null);
        }
    }
}

/**
 * Ask which occurrences of a series an action applies to.
 *
 * @param app Obsidian app, for the modal.
 * @param action What the user is doing. Only changes the wording.
 * @param eventTitle Title of the event being acted on, so the prompt names what
 * it is about to change.
 * @returns The chosen scope, or null if the user cancelled or dismissed the
 * modal. Callers must treat null as "do nothing" — for a drag or resize that
 * means reverting the view, since the occurrence has already moved on screen.
 */
export function promptRecurrenceScope(
    app: App,
    action: RecurrenceAction,
    eventTitle: string
): Promise<RecurrenceScope | null> {
    return new Promise((resolve) => {
        new RecurrenceScopeModal(app, action, eventTitle, resolve).open();
    });
}
