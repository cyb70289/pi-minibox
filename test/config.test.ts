import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import {
    createMiniboxConfigCache,
    DEFAULT_ALLOW_DEVICES,
    DEFAULT_ALLOW_WRITE,
    loadMiniboxConfig,
    MINIBOX_CONFIG_BASENAME,
    MiniboxConfigWriteError,
    miniboxConfigPath,
    serializeMiniboxConfig,
    setMiniboxEnabled,
} from "../src/config.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "minibox-config-"));
let configPath = "";

beforeEach(() => {
    configPath = join(fixtureRoot, `minibox-${Date.now()}-${Math.random()}.json`);
});

after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

describe("miniboxConfigPath", () => {
    it("places the config directly in the agent directory", () => {
        assert.equal(miniboxConfigPath("/home/u/.pi/agent"), `/home/u/.pi/agent/${MINIBOX_CONFIG_BASENAME}`);
    });
});

describe("loadMiniboxConfig", () => {
    it("seeds the packaged defaults when the file is absent", () => {
        const loaded = loadMiniboxConfig(configPath);

        assert.equal(loaded.seeded, true);
        assert.equal(loaded.malformed, false);
        assert.deepEqual(loaded.problems, []);
        assert.equal(loaded.config.enabled, true);
        assert.deepEqual(loaded.config.allowWrite, [...DEFAULT_ALLOW_WRITE]);
        assert.deepEqual(loaded.config.allowDevices, ["/dev/nvidia*", "/dev/dri/*"]);
        assert.deepEqual(loaded.config.allowDevices, [...DEFAULT_ALLOW_DEVICES]);

        const onDisk = JSON.parse(readFileSync(configPath, "utf-8")) as { enabled: boolean };
        assert.equal(onDisk.enabled, true);
    });

    it("reads a valid file", () => {
        writeFileSync(configPath, JSON.stringify({ version: 1, enabled: false, allowWrite: ["/tmp/out"], allowDevices: ["/dev/null"] }));

        const loaded = loadMiniboxConfig(configPath);

        assert.equal(loaded.seeded, false);
        assert.equal(loaded.config.enabled, false);
        assert.deepEqual(loaded.config.allowWrite, ["/tmp/out"]);
        assert.deepEqual(loaded.config.allowDevices, ["/dev/null"]);
    });

    it("falls back to the safe interpretation of unparseable JSON", () => {
        writeFileSync(configPath, "{ not json");

        const loaded = loadMiniboxConfig(configPath);

        assert.equal(loaded.malformed, true);
        assert.equal(loaded.config.allowWrite.length, 0);
        assert.deepEqual(loaded.config.allowDevices, []);
        assert.equal(loaded.config.enabled, true);
        assert.match(loaded.problems[0] ?? "", /could not be parsed/);
    });

    it("drops a non-object document without widening access", () => {
        writeFileSync(configPath, "[1, 2, 3]");

        const loaded = loadMiniboxConfig(configPath);

        assert.equal(loaded.malformed, false);
        assert.deepEqual(loaded.config.allowWrite, []);
        assert.deepEqual(loaded.config.allowDevices, []);
        assert.match(loaded.problems[0] ?? "", /JSON object/);
    });

    it("drops a wrongly typed list instead of guessing", () => {
        writeFileSync(configPath, JSON.stringify({ allowWrite: "~/.npm" }));

        const loaded = loadMiniboxConfig(configPath);

        assert.deepEqual(loaded.config.allowWrite, []);
        assert.equal(loaded.problems.length, 1);
    });

    it("uses the seeded device patterns when an older config has no allowDevices key", () => {
        writeFileSync(configPath, JSON.stringify({ version: 1, allowWrite: [] }));
        assert.deepEqual(loadMiniboxConfig(configPath).config.allowDevices, [...DEFAULT_ALLOW_DEVICES]);
    });

    it("preserves an explicit empty device list", () => {
        writeFileSync(configPath, JSON.stringify({ version: 1, allowDevices: [] }));
        assert.deepEqual(loadMiniboxConfig(configPath).config.allowDevices, []);
    });

    it("drops an invalid allowDevices list without affecting allowWrite", () => {
        writeFileSync(configPath, JSON.stringify({ allowWrite: ["/tmp/out"], allowDevices: ["/dev/null", 42] }));
        const loaded = loadMiniboxConfig(configPath);
        assert.deepEqual(loaded.config.allowDevices, []);
        assert.deepEqual(loaded.config.allowWrite, ["/tmp/out"]);
        assert.match(loaded.problems[0] ?? "", /allowDevices.*array/);
    });

    it("ignores a legacy denyWrite key with a note", () => {
        writeFileSync(configPath, JSON.stringify({ version: 1, enabled: true, denyWrite: [".env"] }));

        const loaded = loadMiniboxConfig(configPath);

        assert.equal(loaded.problems.length, 0);
        assert.ok(loaded.notes.some((note) => /denyWrite.*no longer supported/.test(note)), loaded.notes.join("; "));
    });

    it("notes unknown keys without failing", () => {
        writeFileSync(configPath, JSON.stringify({ version: 1, enabled: true, oops: 1 }));

        const loaded = loadMiniboxConfig(configPath);

        assert.deepEqual(loaded.config.allowWrite, [...DEFAULT_ALLOW_WRITE]);
        assert.deepEqual(loaded.config.allowDevices, [...DEFAULT_ALLOW_DEVICES]);
        assert.deepEqual(loaded.notes, ['minibox.json has an unknown key "oops"; it is ignored.']);
    });

    it("notes a version it does not know", () => {
        writeFileSync(configPath, JSON.stringify({ version: 99, enabled: true }));

        const loaded = loadMiniboxConfig(configPath);

        assert.match(loaded.notes[0] ?? "", /version 99/);
        assert.equal(loaded.config.enabled, true);
    });
});

describe("setMiniboxEnabled", () => {
    it("creates the file when it is absent", () => {
        const config = setMiniboxEnabled(configPath, false);

        assert.equal(config.enabled, false);
        assert.equal(loadMiniboxConfig(configPath).config.enabled, false);
    });

    it("preserves rules and unknown keys while flipping the flag", () => {
        writeFileSync(
            configPath,
            JSON.stringify({ version: 1, enabled: true, allowWrite: ["/tmp/out"], allowDevices: ["/dev/null"], denyWrite: [".env"], custom: "keep" }),
        );

        setMiniboxEnabled(configPath, false);

        const onDisk = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
        assert.equal(onDisk.enabled, false);
        assert.deepEqual(onDisk.allowWrite, ["/tmp/out"]);
        assert.deepEqual(onDisk.allowDevices, ["/dev/null"]);
        assert.equal("denyWrite" in onDisk, false, "a removed feature is not written back");
        assert.equal(onDisk.custom, "keep");
    });

    it("refuses to rewrite a file it cannot parse", () => {
        writeFileSync(configPath, "{ not json");

        assert.throws(() => setMiniboxEnabled(configPath, false), MiniboxConfigWriteError);
        assert.equal(readFileSync(configPath, "utf-8"), "{ not json");
    });
});

describe("createMiniboxConfigCache", () => {
    function memoryConfig(initial: string) {
        let contents = initial;
        let mtimeMs = 1;
        const seams = {
            exists: () => contents !== "",
            readFile: () => contents,
            writeFile: (_path: string, next: string) => {
                contents = next;
                mtimeMs += 1;
            },
            ensureDir: () => {},
            mtime: () => mtimeMs,
        };
        return {
            seams,
            replace(next: string) {
                contents = next;
            },
            touch() {
                mtimeMs += 1;
            },
            read: () => contents,
        };
    }

    it("reuses the loaded config while the file is unchanged", () => {
        const memory = memoryConfig(JSON.stringify({ version: 1, enabled: true, allowWrite: ["/a"] }));
        const cache = createMiniboxConfigCache("/cfg/minibox.json", memory.seams);

        assert.deepEqual(cache.load().config.allowWrite, ["/a"]);
        memory.replace(JSON.stringify({ version: 1, enabled: true, allowWrite: ["/b"] }));
        assert.deepEqual(cache.load().config.allowWrite, ["/a"], "an unchanged mtime keeps the cached copy");
    });

    it("re-reads after the file changes", () => {
        const memory = memoryConfig(JSON.stringify({ version: 1, enabled: true, allowWrite: ["/a"] }));
        const cache = createMiniboxConfigCache("/cfg/minibox.json", memory.seams);
        cache.load();

        memory.replace(JSON.stringify({ version: 1, enabled: false, allowWrite: ["/b"], allowDevices: ["/dev/null"] }));
        memory.touch();

        const loaded = cache.load();
        assert.deepEqual(loaded.config.allowWrite, ["/b"]);
        assert.deepEqual(loaded.config.allowDevices, ["/dev/null"]);
        assert.equal(loaded.config.enabled, false);
    });

    it("re-reads after an invalidate even when the mtime is unchanged", () => {
        const memory = memoryConfig(JSON.stringify({ version: 1, enabled: true, allowWrite: ["/a"] }));
        const cache = createMiniboxConfigCache("/cfg/minibox.json", memory.seams);
        cache.load();

        memory.replace(JSON.stringify({ version: 1, enabled: true, allowWrite: ["/b"] }));
        cache.invalidate();

        assert.deepEqual(cache.load().config.allowWrite, ["/b"]);
    });

    it("seeds a missing file and caches the seeded value", () => {
        const seams = {
            exists: () => false,
            readFile: () => "",
            writeFile: () => {},
            ensureDir: () => {},
            mtime: () => 1,
        };
        const cache = createMiniboxConfigCache("/cfg/minibox.json", seams);

        assert.equal(cache.load().seeded, true);
        assert.equal(cache.load().seeded, true);
    });
});

describe("serializeMiniboxConfig", () => {
    it("round-trips through the loader", () => {
        writeFileSync(configPath, serializeMiniboxConfig({ version: 1, enabled: false, allowWrite: ["~/x"], allowDevices: ["/dev/null"] }));

        const loaded = loadMiniboxConfig(configPath);

        assert.equal(loaded.config.enabled, false);
        assert.deepEqual(loaded.config.allowWrite, ["~/x"]);
        assert.deepEqual(loaded.config.allowDevices, ["/dev/null"]);
    });
});
