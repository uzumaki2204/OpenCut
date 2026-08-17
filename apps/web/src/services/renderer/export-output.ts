import {
	BufferTarget,
	Mp4OutputFormat,
	StreamTarget,
	WebMOutputFormat,
} from "mediabunny";
import type { ExportDestination, ExportFormat } from "@/lib/export";
import { EXPORT_TEXT } from "@/lib/export/language";

const EXPORT_STREAM_CHUNK_SIZE = 32 * 1024 * 1024;

export type ExportOutputTarget = BufferTarget | StreamTarget;
export type ExportOutputResult =
	| { kind: "saved" }
	| { kind: "buffer"; buffer: ArrayBuffer };

export function createExportOutputTarget({
	destination,
}: {
	destination: ExportDestination;
}): ExportOutputTarget {
	return destination.kind === "stream"
		? new StreamTarget(destination.writable, {
				chunked: true,
				chunkSize: EXPORT_STREAM_CHUNK_SIZE,
			})
		: new BufferTarget();
}

export function createExportOutputFormat({
	format,
	destination,
}: {
	format: ExportFormat;
	destination: ExportDestination;
}): Mp4OutputFormat | WebMOutputFormat {
	if (format === "webm") return new WebMOutputFormat();

	// A streamed MP4 keeps metadata at the end, avoiding an in-memory mdat.
	return destination.kind === "stream"
		? new Mp4OutputFormat({ fastStart: false })
		: new Mp4OutputFormat();
}

export function getExportOutputResult({
	target,
}: {
	target: ExportOutputTarget;
}): ExportOutputResult {
	if (target instanceof BufferTarget) {
		if (!target.buffer) {
			throw new Error(EXPORT_TEXT.errors.missingBuffer);
		}
		return { kind: "buffer", buffer: target.buffer };
	}

	return { kind: "saved" };
}
