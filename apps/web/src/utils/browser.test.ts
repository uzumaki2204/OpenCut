import { describe, expect, test } from "bun:test";
import { isProtectedExportSource } from "./browser";

describe("isProtectedExportSource", () => {
	test("detects attempts to overwrite the imported source", () => {
		const selectedFile = new File([new Uint8Array(4)], "4316172.mp4");

		expect(
			isProtectedExportSource({
				file: selectedFile,
				sources: [{ name: "4316172.mp4", size: 4 }],
			}),
		).toBe(true);
	});

	test("allows a different filename or different file size", () => {
		const selectedFile = new File([new Uint8Array(4)], "4316172-direct.mp4");

		expect(
			isProtectedExportSource({
				file: selectedFile,
				sources: [{ name: "4316172.mp4", size: 4 }],
			}),
		).toBe(false);
		expect(
			isProtectedExportSource({
				file: selectedFile,
				sources: [{ name: "4316172-direct.mp4", size: 8 }],
			}),
		).toBe(false);
	});
});
