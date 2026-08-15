import { describe, expect, test } from "bun:test";
import {
	getMediaStorageMode,
	getMediaStorageSummary,
	MAX_OPFS_MEDIA_BYTES,
} from "./persistence";

function createFile({ size }: { size: number }): File {
	return { size } as File;
}

describe("getMediaStorageMode", () => {
	test("keeps small media in OPFS", () => {
		expect(getMediaStorageMode({ file: createFile({ size: 1024 }) })).toBe(
			"opfs",
		);
	});

	test("links large media when a source handle is available", () => {
		const sourceHandle = { kind: "file" } as FileSystemFileHandle;
		expect(
			getMediaStorageMode({
				file: createFile({ size: MAX_OPFS_MEDIA_BYTES + 1 }),
				sourceHandle,
			}),
		).toBe("handle");
	});

	test("keeps large media session-only without a source handle", () => {
		expect(
			getMediaStorageMode({
				file: createFile({ size: MAX_OPFS_MEDIA_BYTES + 1 }),
			}),
		).toBe("session");
	});

	test("summarizes linked and session-only assets", () => {
		expect(
			getMediaStorageSummary({
				assets: [
					{ storageMode: "opfs" },
					{ storageMode: "handle" },
					{ storageMode: "session" },
				],
			}),
		).toEqual({ handleLinkedCount: 1, sessionOnlyCount: 1 });
	});
});
