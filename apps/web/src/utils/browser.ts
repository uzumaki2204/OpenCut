import type { StreamTargetChunk } from "mediabunny";
import type { ExportDestination, ExportDestinationMetrics } from "@/lib/export";
import { EXPORT_TEXT } from "@/lib/export/language";

const DEFAULT_EXPORT_FLUSH_BYTES = 64 * 1024 * 1024;

type ShowSaveFilePicker = (options: {
	suggestedName: string;
	types: Array<{
		description: string;
		accept: Record<string, string[]>;
	}>;
}) => Promise<FileSystemFileHandle>;

type WindowWithSaveFilePicker = Window & {
	showSaveFilePicker?: ShowSaveFilePicker;
};

export interface ExportSourceIdentity {
	name: string;
	size: number;
}

export function createBufferedExportWritable({
	writeChunk,
	flushThresholdBytes = DEFAULT_EXPORT_FLUSH_BYTES,
}: {
	writeChunk: (chunk: StreamTargetChunk) => Promise<void>;
	flushThresholdBytes?: number;
}): {
	writable: WritableStream<StreamTargetChunk>;
	flush: () => Promise<void>;
	getMetrics: () => ExportDestinationMetrics;
	setCloseElapsedMs: (elapsedMs: number) => void;
} {
	if (!Number.isFinite(flushThresholdBytes) || flushThresholdBytes <= 0) {
		throw new RangeError(EXPORT_TEXT.errors.invalidFlushThreshold);
	}

	let pendingPosition = 0;
	let pendingByteLength = 0;
	let pendingParts: Uint8Array<ArrayBuffer>[] = [];
	const metrics: ExportDestinationMetrics = {
		bytesWritten: 0,
		writeCalls: 0,
		flushCount: 0,
		writeElapsedMs: 0,
		closeElapsedMs: 0,
		maxFlushBytes: 0,
	};

	const writeToFile = async (chunk: StreamTargetChunk): Promise<void> => {
		const startedAt = performance.now();
		await writeChunk(chunk);
		metrics.writeElapsedMs += performance.now() - startedAt;
		metrics.bytesWritten += chunk.data.byteLength;
		metrics.writeCalls += 1;
		metrics.flushCount += 1;
		metrics.maxFlushBytes = Math.max(
			metrics.maxFlushBytes,
			chunk.data.byteLength,
		);
	};

	const flush = async (): Promise<void> => {
		if (pendingByteLength === 0) return;
		const data =
			pendingParts.length === 1
				? pendingParts[0]
				: new Uint8Array(pendingByteLength);
		if (pendingParts.length > 1) {
			let offset = 0;
			for (const part of pendingParts) {
				data.set(part, offset);
				offset += part.byteLength;
			}
		}

		const position = pendingPosition;
		pendingParts = [];
		pendingByteLength = 0;
		await writeToFile({ type: "write", data, position });
	};

	const writable = new WritableStream<StreamTargetChunk>({
		write: async (chunk) => {
			if (chunk.data.byteLength === 0) return;
			const isContiguous =
				pendingByteLength === 0 ||
				chunk.position === pendingPosition + pendingByteLength;
			const fitsPendingBuffer =
				pendingByteLength + chunk.data.byteLength <= flushThresholdBytes;

			if (!isContiguous || !fitsPendingBuffer) await flush();
			if (chunk.data.byteLength >= flushThresholdBytes) {
				await writeToFile(chunk);
				return;
			}

			if (pendingByteLength === 0) pendingPosition = chunk.position;
			pendingParts.push(chunk.data);
			pendingByteLength += chunk.data.byteLength;
			if (pendingByteLength >= flushThresholdBytes) await flush();
		},
		close: flush,
		abort: flush,
	});

	return {
		writable,
		flush,
		getMetrics: () => ({ ...metrics }),
		setCloseElapsedMs: (elapsedMs) => {
			metrics.closeElapsedMs = elapsedMs;
		},
	};
}

export function isProtectedExportSource({
	file,
	sources,
}: {
	file: File;
	sources: ExportSourceIdentity[];
}): boolean {
	const normalizedFileName = file.name.toLowerCase();
	return sources.some(
		(source) =>
			source.size === file.size &&
			source.name.toLowerCase() === normalizedFileName,
	);
}

export async function createExportDestination({
	filename,
	mimeType,
	extension,
	allowBufferFallback = true,
	protectedSources = [],
}: {
	filename: string;
	mimeType: string;
	extension: string;
	allowBufferFallback?: boolean;
	protectedSources?: ExportSourceIdentity[];
}): Promise<ExportDestination | null> {
	const showSaveFilePicker = (window as WindowWithSaveFilePicker)
		.showSaveFilePicker;
	if (!showSaveFilePicker) {
		if (!allowBufferFallback) {
			throw new Error(EXPORT_TEXT.errors.directExportRequiresFilePicker);
		}
		return { kind: "buffer" };
	}

	try {
		const safeFilename =
			filename.replace(/[<>:"/\\|?*]/g, "-").trim() ||
			`${EXPORT_TEXT.ui.defaultFilename}${extension}`;
		const fileHandle = await showSaveFilePicker.call(window, {
			suggestedName: safeFilename,
			types: [
				{
					description: EXPORT_TEXT.ui.fileTypeVideo,
					accept: { [mimeType]: [extension] },
				},
			],
		});
		const selectedFile = await fileHandle.getFile();
		if (
			isProtectedExportSource({ file: selectedFile, sources: protectedSources })
		) {
			throw new Error(EXPORT_TEXT.errors.directExportCannotOverwriteSource);
		}
		const fileStream = await fileHandle.createWritable();
		let settled = false;
		const buffered = createBufferedExportWritable({
			writeChunk: (chunk) => fileStream.write(chunk),
		});

		return {
			kind: "stream",
			writable: buffered.writable,
			complete: async () => {
				if (settled) return;
				settled = true;
				await buffered.flush();
				const closeStartedAt = performance.now();
				await fileStream.close();
				buffered.setCloseElapsedMs(performance.now() - closeStartedAt);
			},
			cancel: async () => {
				if (settled) return;
				settled = true;
				await buffered.flush();
				await fileStream.abort();
			},
			getMetrics: buffered.getMetrics,
		};
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") {
			return null;
		}
		throw error;
	}
}

export function downloadBlob({
	blob,
	filename,
}: {
	blob: Blob;
	filename: string;
}): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	URL.revokeObjectURL(url);
}

export function findScrollParent({
	element,
}: {
	element: HTMLElement;
}): HTMLElement | null {
	let parent = element.parentElement;
	while (parent) {
		const { overflow, overflowX } = window.getComputedStyle(parent);
		if (/auto|scroll/.test(overflow + overflowX)) return parent;
		parent = parent.parentElement;
	}
	return null;
}

export function isTypableDOMElement({
	element,
}: {
	element: HTMLElement;
}): boolean {
	if (element.isContentEditable) return true;

	if (element.tagName === "INPUT") {
		return !(element as HTMLInputElement).disabled;
	}

	if (element.tagName === "TEXTAREA") {
		return !(element as HTMLTextAreaElement).disabled;
	}

	return false;
}
