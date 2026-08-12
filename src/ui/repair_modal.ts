import { App, Modal, Notice } from "obsidian";

/**
 * Dry run for the filename repair, shown before anything is renamed.
 *
 * The modal is deliberately dumb: it is handed lines of text and a callback,
 * and knows nothing about calendars, events or the vault. Planning and applying
 * both live on the `calendars` side of the architecture invariant, which is
 * what keeps the ui layer from holding a write path to notes.
 */
export class FilenameRepairModal extends Modal {
    private summary: string;
    private lines: string[];
    private renameCount: number;
    private onApply: () => Promise<void>;

    /**
     * @param summary One-line description of what the repair would do.
     * @param lines The plan itself, one line each, already formatted.
     * @param renameCount How many renames the plan contains. Zero renders a
     * report with no apply button — there is nothing to approve.
     * @param onApply Callback performing the renames.
     */
    constructor(
        app: App,
        summary: string,
        lines: string[],
        renameCount: number,
        onApply: () => Promise<void>
    ) {
        super(app);
        this.summary = summary;
        this.lines = lines;
        this.renameCount = renameCount;
        this.onApply = onApply;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "Repair event filenames" });
        contentEl.createEl("p", { text: this.summary });

        if (this.lines.length > 0) {
            const pre = contentEl.createEl("pre", {
                text: this.lines.join("\n"),
            });
            pre.style.maxHeight = "50vh";
            pre.style.overflow = "auto";
            pre.style.whiteSpace = "pre";
            pre.style.userSelect = "text";
        }

        const buttons = contentEl.createDiv();
        buttons.style.display = "flex";
        buttons.style.gap = "0.5em";
        buttons.style.justifyContent = "flex-end";
        buttons.style.marginTop = "1em";

        if (this.renameCount === 0) {
            const close = buttons.createEl("button", { text: "Close" });
            close.addEventListener("click", () => this.close());
            return;
        }

        const cancel = buttons.createEl("button", { text: "Cancel" });
        cancel.addEventListener("click", () => this.close());

        const apply = buttons.createEl("button", {
            text: `Rename ${this.renameCount} note${
                this.renameCount === 1 ? "" : "s"
            }`,
        });
        apply.addClass("mod-cta");
        apply.addEventListener("click", async () => {
            // Disabled immediately: the renames are not instant, and a second
            // click would apply a plan that has already been half-applied.
            apply.disabled = true;
            cancel.disabled = true;
            apply.textContent = "Renaming…";
            try {
                await this.onApply();
                this.close();
            } catch (e) {
                console.error("Filename repair failed", e);
                new Notice(
                    `Filename repair failed: ${
                        e instanceof Error ? e.message : String(e)
                    }`
                );
                this.close();
            }
        });
    }

    onClose(): void {
        this.contentEl.empty();
    }
}
