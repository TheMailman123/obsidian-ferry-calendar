/**
 * Copies build artefacts into a local Obsidian vault for testing.
 *
 * The plugin repo is self-contained and knows nothing about any vault. The
 * target is supplied at runtime, so no personal path is ever committed:
 *
 *   FERRY_VAULT=/path/to/vault npm run deploy
 *
 * or persisted in .deploy.local.json (gitignored):
 *
 *   { "vault": "/path/to/vault" }
 *
 * Fails loudly on a missing target or missing build output rather than
 * silently deploying a stale plugin.
 */

import {
    existsSync,
    mkdirSync,
    copyFileSync,
    readFileSync,
    readdirSync,
    statSync,
} from "fs";
import { join, resolve } from "path";

const PLUGIN_ID = JSON.parse(readFileSync("manifest.json", "utf8")).id;
const LOCAL_CONFIG = ".deploy.local.json";

/**
 * Deploy targets, in precedence order: FERRY_VAULT (single vault, for one-off
 * deploys), then `vaults` or `vault` from the local config. `vaults` exists
 * because the plugin is routinely deployed to more than one vault at a time.
 *
 * @returns {string[]} one or more vault paths, unresolved
 */
function resolveVaults() {
    if (process.env.FERRY_VAULT) return [process.env.FERRY_VAULT];

    if (existsSync(LOCAL_CONFIG)) {
        const { vault, vaults } = JSON.parse(readFileSync(LOCAL_CONFIG, "utf8"));

        if (vaults !== undefined) {
            if (!Array.isArray(vaults) || vaults.length === 0) {
                throw new Error(
                    `'vaults' in ${LOCAL_CONFIG} must be a non-empty array of paths.`
                );
            }
            // Both keys set is ambiguous about which wins — refuse rather than pick.
            if (vault !== undefined) {
                throw new Error(
                    `${LOCAL_CONFIG} sets both 'vault' and 'vaults'. Use one.`
                );
            }
            return vaults;
        }

        if (vault) return [vault];
    }

    throw new Error(
        `No deploy target. Set FERRY_VAULT=/path/to/vault, or create ${LOCAL_CONFIG} with ` +
            `{ "vault": "/path/to/vault" } or { "vaults": ["/path/one", "/path/two"] }.`
    );
}

// Validate every target before copying into any of them, so a typo in the
// second path cannot leave the first vault updated and the second stale.
const vaults = resolveVaults().map((v) => resolve(v));
for (const vault of vaults) {
    if (!existsSync(join(vault, ".obsidian"))) {
        throw new Error(`Not an Obsidian vault (no .obsidian directory): ${vault}`);
    }
}

// esbuild emits main.css; Obsidian expects it as styles.css.
const artefacts = [
    ["main.js", "main.js"],
    ["manifest.json", "manifest.json"],
    ["main.css", "styles.css"],
];

for (const [src, dest] of artefacts) {
    if (!existsSync(src)) {
        throw new Error(`Missing build artefact '${src}'. Run 'npm run build' first.`);
    }
}

/** Most recent mtime of any file under a directory, in ms. */
function newestMtime(dir) {
    let newest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const mtime = entry.isDirectory()
            ? newestMtime(full)
            : statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
    }
    return newest;
}

// `npm run deploy` is usable on its own, so an artefact older than the sources
// means the developer is about to test code they did not build. Refuse rather
// than reporting a successful deploy of a stale bundle.
const newestSource = newestMtime("src");
const builtAt = statSync("main.js").mtimeMs;
if (builtAt < newestSource) {
    throw new Error(
        "main.js is older than files in src/. Run 'npm run build' (or use 'npm run build:deploy')."
    );
}

for (const vault of vaults) {
    const target = join(vault, ".obsidian", "plugins", PLUGIN_ID);
    mkdirSync(target, { recursive: true });

    for (const [src, dest] of artefacts) {
        copyFileSync(src, join(target, dest));
    }

    console.log(`Deployed ${PLUGIN_ID} → ${target}`);
}

console.log(artefacts.map(([, d]) => `  ${d}`).join("\n"));
