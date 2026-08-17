import { describe, expect, test } from "bun:test";
import type { StreamTargetChunk } from "mediabunny";
import {
	createBufferedExportWritable,
	isProtectedExportSource,
} from "./browser";

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

describe("createBufferedExportWritable", () => {
	test("coalesces contiguous chunks before writing", async () => {
		const writes: StreamTargetChunk[] = [];
		const buffered = createBufferedExportWritable({
			flushThresholdBytes: 6,
			writeChunk: async (chunk) => {
				writes.push(chunk);
			},
		});
		const writer = buffered.writable.getWriter();

		await writer.write({
			type: "write",
			position: 0,
			data: new Uint8Array([1, 2]),
		});
		await writer.write({
			type: "write",
			position: 2,
			data: new Uint8Array([3, 4]),
		});
		expect(writes).toHaveLength(0);
		await writer.write({
			type: "write",
			position: 4,
			data: new Uint8Array([5, 6]),
		});
		await writer.close();

		expect(writes).toHaveLength(1);
		expect(writes[0]?.position).toBe(0);
		expect([...((writes[0]?.data ?? new Uint8Array()) as Uint8Array)]).toEqual([
			1, 2, 3, 4, 5, 6,
		]);
		expect(buffered.getMetrics()).toMatchObject({
			bytesWritten: 6,
			writeCalls: 1,
			flushCount: 1,
			maxFlushBytes: 6,
		});
	});

	test("flushes before a non-contiguous write", async () => {
		const writes: StreamTargetChunk[] = [];
		const buffered = createBufferedExportWritable({
			flushThresholdBytes: 8,
			writeChunk: async (chunk) => {
				writes.push(chunk);
			},
		});
		const writer = buffered.writable.getWriter();

		await writer.write({
			type: "write",
			position: 0,
			data: new Uint8Array([1, 2]),
		});
		await writer.write({
			type: "write",
			position: 4,
			data: new Uint8Array([3, 4]),
		});
		await writer.close();

		expect(writes.map((chunk) => chunk.position)).toEqual([0, 4]);
		expect(writes.map((chunk) => [...chunk.data])).toEqual([
			[1, 2],
			[3, 4],
		]);
	});
});
