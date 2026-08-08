import { TFile } from "obsidian";
import { MockAppBuilder } from "./AppBuilder";
import { FileBuilder } from "./FileBuilder";
import { MockVault } from "./MockVault";

/**
 * These cover the mutating half of MockVault, which nothing else exercises.
 * Both cases below were broken for as long as the mock has existed and went
 * unnoticed because every test only ever read from a pre-built vault.
 */
describe("MockVault write operations", () => {
    let vault: MockVault;
    beforeEach(() => {
        vault = MockAppBuilder.make()
            .file("existing.md", new FileBuilder().text("hello"))
            .done().vault;
    });

    it("creates a file and reads it back", async () => {
        // setParent used to throw unconditionally, so create() could never
        // succeed - the success path fell through into the error branch.
        const file = await vault.create("/new.md", "contents");

        expect(file).toBeInstanceOf(TFile);
        expect(await vault.read(file)).toBe("contents");
        expect(vault.getFileByPath("/new.md")).toBe(file);
    });

    it("creates a folder and returns it", async () => {
        const folder = await vault.createFolder("/sub");

        expect(vault.getFolderByPath("/sub")).toBe(folder);
        expect(vault.getAllFolders()).toContain(folder);
    });

    it("reads an empty file as an empty string", async () => {
        // An empty note is valid. A truthiness check on the contents would
        // report it as a file with no contents at all.
        const file = await vault.create("/empty.md", "");

        expect(await vault.read(file)).toBe("");
    });

    it("processes an empty file rather than rejecting it", async () => {
        const file = await vault.create("/empty.md", "");

        const result = await vault.process(file, (data: string) => data + "x");

        expect(result).toBe("x");
        expect(await vault.read(file)).toBe("x");
    });

    it("throws when the parent folder does not exist", async () => {
        await expect(
            vault.create("/missing-folder/file.md", "contents")
        ).rejects.toThrow("is not a folder");
    });
});
