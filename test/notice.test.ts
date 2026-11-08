import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    readStartupNotices,
    startupEntryData,
    startupNoticeLines,
    wrapText,
    type NoticeTheme,
} from "../src/notice.ts";

const theme: NoticeTheme = {
    fg: (color, text) => `<${color}>${text}</>`,
};

describe("readStartupNotices", () => {
    it("reads valid notices and ignores malformed items", () => {
        const data = startupEntryData([
            { message: "minibox on", level: "info" },
            { message: "a warning", level: "warning" },
        ]);

        assert.deepEqual(readStartupNotices(data), [
            { message: "minibox on", level: "info" },
            { message: "a warning", level: "warning" },
        ]);

        assert.deepEqual(
            readStartupNotices({
                notices: [
                    { message: "kept", level: "error" },
                    { message: "", level: "info" },
                    { message: "bad level", level: "success" },
                    { message: 42, level: "info" },
                    null,
                ],
            }),
            [{ message: "kept", level: "error" }],
        );
    });

    it("rejects data that carries no usable notice", () => {
        for (const data of [undefined, null, {}, { notices: "nope" }, { notices: [] }, { notices: [{}] }]) {
            assert.equal(readStartupNotices(data), undefined);
        }
    });
});

describe("wrapText", () => {
    it("wraps on words and hard-splits a word wider than the line", () => {
        assert.deepEqual(wrapText("minibox on and writes confined", 12), [
            "minibox on",
            "and writes",
            "confined",
        ]);
        assert.deepEqual(wrapText("abcdefghijkl", 5), ["abcde", "fghij", "kl"]);
        assert.deepEqual(wrapText("", 10), [""]);
    });
});

describe("startupNoticeLines", () => {
    it("renders one colored line per notice with a leading space", () => {
        const lines = startupNoticeLines(
            startupEntryData([
                { message: "minibox on", level: "info" },
                { message: "writes blocked", level: "warning" },
                { message: "no backend", level: "error" },
            ]),
            theme,
            80,
        );

        assert.deepEqual(lines, [
            " <dim>minibox on</>",
            " <warning>writes blocked</>",
            " <error>no backend</>",
        ]);
    });

    it("wraps to the viewport width, including the leading space", () => {
        const lines = startupNoticeLines(
            startupEntryData([{ message: "one two three four", level: "info" }]),
            theme,
            8,
        );

        assert.deepEqual(lines, [" <dim>one two</>", " <dim>three</>", " <dim>four</>"]);
        for (const line of lines ?? []) assert.ok(line.replace(/<[^>]+>/g, "").length <= 8);
    });

    it("renders nothing for malformed data", () => {
        assert.equal(startupNoticeLines({}, theme, 80), undefined);
        assert.equal(startupNoticeLines(startupEntryData([]), theme, 80), undefined);
    });
});
