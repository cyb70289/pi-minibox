import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import {
    DEFAULT_ALLOW_WRITE,
    DEFAULT_DENY_WRITE,
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
        assert.deepEqual(loaded.config.denyWrite, [...DEFAULT_DENY_WRITE]);

        const onDisk = JSON.parse(readFileSync(configPath, "utf-8")) as { enabled: boolean };
        assert.equal(onDisk.enabled, true);
    });

    it("reads a valid file", () => {
        writeFileSync(configPath, JSON.stringify({ version: 1, enabled: false, allowWrite: ["/tmp/out"], denyWrite: [".env"] }));

        const loaded = loadMiniboxConfig(configPath);

        assert.equal(loaded.seeded, false);
        assert.equal(loaded.config.enabled, false);
        assert.deepEqual(loaded.config.allowWrite, ["/tmp/out"]);
        assert.deepEqual(loaded.config.denyWrite, [".env"]);
    });

    it("falls back to the safe interpretation of unparseable JSON", () => {
        writeFileSync(configPath, "{ not json");

        const loaded = loadMiniboxConfig(configPath);

        assert.equal(loaded.malformed, true);
        assert.equal(loaded.config.allowWrite.length, 0);
        assert.equal(loaded.config.denyWrite.length, 0);
        assert.equal(loaded.config.enabled, true);
        assert.match(loaded.problems[0] ?? "", /could not be parsed/);
    });

    it("drops a non-object document without widening access", () => {
        writeFileSync(configPath, "[1, 2, 3]");

        const loaded = loadMiniboxConfig(configPath);

        assert.equal(loaded.malformed, false);
        assert.deepEqual(loaded.config.allowWrite, []);
        assert.deepEqual(loaded.config.denyWrite, []);
        assert.match(loaded.problems[0] ?? "", /JSON object/);
    });

    it("drops a wrongly typed list instead of guessing", () => {
        writeFileSync(configPath, JSON.stringify({ allowWrite: "~/.npm", denyWrite: [7] }));

        const loaded = loadMiniboxConfig(configPath);

        assert.deepEqual(loaded.config.allowWrite, []);
        assert.deepEqual(loaded.config.denyWrite, []);
        assert.equal(loaded.problems.length, 2);
    });

    it("notes unknown keys without failing", () => {
        writeFileSync(configPath, JSON.stringify({ version: 1, enabled: true, oops: 1 }));

        const loaded = loadMiniboxConfig(configPath);

        assert.deepEqual(loaded.config.allowWrite, [...DEFAULT_ALLOW_WRITE]);
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
            JSON.stringify({ version: 1, enabled: true, allowWrite: ["/tmp/out"], denyWrite: [".env"], custom: "keep" }),
        );

        setMiniboxEnabled(configPath, false);

        const onDisk = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
        assert.equal(onDisk.enabled, false);
        assert.deepEqual(onDisk.allowWrite, ["/tmp/out"]);
        assert.deepEqual(onDisk.denyWrite, [".env"]);
        assert.equal(onDisk.custom, "keep");
    });

    it("refuses to rewrite a file it cannot parse", () => {
        writeFileSync(configPath, "{ not json");

        assert.throws(() => setMiniboxEnabled(configPath, false), MiniboxConfigWriteError);
        assert.equal(readFileSync(configPath, "utf-8"), "{ not json");
    });
});

describe("serializeMiniboxConfig", () => {
    it("round-trips through the loader", () => {
        writeFileSync(configPath, serializeMiniboxConfig({ version: 1, enabled: false, allowWrite: ["~/x"], denyWrite: [] }));

        const loaded = loadMiniboxConfig(configPath);

        assert.equal(loaded.config.enabled, false);
        assert.deepEqual(loaded.config.allowWrite, ["~/x"]);
    });
});
