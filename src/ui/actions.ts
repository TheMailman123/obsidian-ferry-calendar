import { MarkdownView, TFile, Vault, Workspace } from "obsidian";
import EventCache from "src/core/EventCache";

/**
 * Open a file in the editor to a given event.
 *
 * Works for any event that came from a note, editable or not: a derived
 * calendar's events point at notes the plugin only reads, and opening one is
 * the main thing you can do with them.
 *
 * @param cache
 * @param param1 App
 * @param id event ID
 * @param split open in a new split rather than reusing the current leaf
 * @returns
 */
export async function openFileForEvent(
    cache: EventCache,
    { workspace, vault }: { workspace: Workspace; vault: Vault },
    id: string,
    split = false
) {
    const details = cache.getInfoForEvent(id);
    if (!details) {
        throw new Error("Event does not have local representation.");
    }
    const {
        location: { path, lineNumber },
    } = details;
    const file = vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
        return;
    }

    let leaf = split
        ? workspace.getLeaf("split")
        : workspace.getMostRecentLeaf();
    if (!leaf) {
        return;
    }
    if (leaf.getViewState().pinned) {
        leaf = workspace.getLeaf("tab");
    }
    await leaf.openFile(file);
    if (lineNumber && leaf.view instanceof MarkdownView) {
        leaf.view.editor.setCursor({ line: lineNumber, ch: 0 });
    }
}
