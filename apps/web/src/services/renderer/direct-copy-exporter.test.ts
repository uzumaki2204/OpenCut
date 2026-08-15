import { describe, expect, test } from "bun:test";
import type { StreamTargetChunk } from "mediabunny";
import type { ExportDestination } from "@/lib/export";
import type { DirectCopyExportCandidate } from "@/lib/export/strategy";
import { DirectCopyExporter } from "./direct-copy-exporter";

function createCandidate({
	data,
}: {
	data: Uint8Array;
}): DirectCopyExportCandidate {
	const fileBytes = new Uint8Array(data.byteLength);
	fileBytes.set(data);
	return {
		kind: "copy",
		mediaAsset: {
			id: "media-1",
			name: "Source",
			type: "video",
			file: new File([fileBytes.buffer], "source.mp4", {
				type: "video/mp4",
			}),
		},
	};
}

function createStreamDestination({
	writes,
}: {
	writes: StreamTargetChunk[];
}): ExportDestination {
	return {
		kind: "stream",
		writable: new WritableStream<StreamTargetChunk>({
			write: (chunk) => {
				writes.push(chunk);
			},
		}),
		complete: async () => undefined,
		cancel: async () => undefined,
	};
}

describe("DirectCopyExporter", () => {
	test("writes source bytes in chunks and reaches 100% progress", async () => {
		const writes: StreamTargetChunk[] = [];
		const progress: number[] = [];
		const exporter = new DirectCopyExporter({
			candidate: createCandidate({ data: new Uint8Array([1, 2, 3, 4, 5]) }),
			destination: createStreamDestination({ writes }),
			chunkSize: 2,
		});
		exporter.on("progress", (value) => progress.push(value));

		const result = await exporter.export();

		expect(result).toEqual({ kind: "saved" });
		expect(writes.map((chunk) => chunk.position)).toEqual([0, 2, 4]);
		expect(writes.flatMap((chunk) => Array.from(chunk.data))).toEqual([
			1, 2, 3, 4, 5,
		]);
		expect(progress.at(-1)).toBe(1);
	});

	test("stops between chunks when cancelled", async () => {
		const writes: StreamTargetChunk[] = [];
		const exporter = new DirectCopyExporter({
			candidate: createCandidate({ data: new Uint8Array([1, 2, 3, 4, 5]) }),
			destination: createStreamDestination({ writes }),
			chunkSize: 2,
		});
		exporter.on("progress", () => exporter.cancel());

		const result = await exporter.export();

		expect(result).toBeNull();
		expect(writes).toHaveLength(1);
	});

	test("returns the original bytes for compatibility buffer output", async () => {
		const exporter = new DirectCopyExporter({
			candidate: createCandidate({ data: new Uint8Array([7, 8, 9]) }),
			destination: { kind: "buffer" },
		});

		const result = await exporter.export();

		expect(result?.kind).toBe("buffer");
		if (result?.kind !== "buffer") throw new Error("Expected buffer result");
		expect(Array.from(new Uint8Array(result.buffer))).toEqual([7, 8, 9]);
	});
});
