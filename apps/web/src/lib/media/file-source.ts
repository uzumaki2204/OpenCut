import { MEDIA_TEXT } from "./language";
import type { MediaFileSource } from "./types";

type ShowOpenFilePicker = (options?: {
	multiple?: boolean;
	types?: Array<{
		description: string;
		accept: Record<string, string[]>;
	}>;
}) => Promise<FileSystemFileHandle[]>;

type WindowWithOpenFilePicker = Window & {
	showOpenFilePicker?: ShowOpenFilePicker;
};

const MEDIA_PICKER_TYPES = [
	{
		description: MEDIA_TEXT.mediaFiles,
		accept: {
			"video/mp4": [".mp4", ".m4v"],
			"video/quicktime": [".mov"],
			"video/webm": [".webm"],
			"video/x-matroska": [".mkv"],
			"video/x-msvideo": [".avi"],
			"audio/mpeg": [".mp3"],
			"audio/wav": [".wav"],
			"audio/aac": [".aac"],
			"audio/mp4": [".m4a"],
			"audio/ogg": [".ogg"],
			"audio/flac": [".flac"],
			"image/png": [".png"],
			"image/jpeg": [".jpg", ".jpeg"],
			"image/webp": [".webp"],
			"image/gif": [".gif"],
			"image/svg+xml": [".svg"],
		},
	},
];

export function supportsMediaFilePicker(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof (window as WindowWithOpenFilePicker).showOpenFilePicker ===
			"function"
	);
}

export async function pickMediaFileSources({
	multiple,
}: {
	multiple: boolean;
}): Promise<MediaFileSource[]> {
	const showOpenFilePicker = (window as WindowWithOpenFilePicker)
		.showOpenFilePicker;
	if (!showOpenFilePicker) return [];

	const handles = await showOpenFilePicker.call(window, {
		multiple,
		types: MEDIA_PICKER_TYPES,
	});
	return Promise.all(
		handles.map(async (sourceHandle) => ({
			file: await sourceHandle.getFile(),
			sourceHandle,
		})),
	);
}

export async function getDroppedMediaFileSources({
	dataTransfer,
}: {
	dataTransfer: DataTransfer;
}): Promise<MediaFileSource[]> {
	const sources: MediaFileSource[] = [];

	for (const item of Array.from(dataTransfer.items)) {
		if (item.kind !== "file") continue;
		const file = item.getAsFile();
		if (!file) continue;

		let sourceHandle: FileSystemFileHandle | undefined;
		try {
			const handle = await item.getAsFileSystemHandle?.();
			if (handle?.kind === "file") {
				sourceHandle = handle as FileSystemFileHandle;
			}
		} catch {
			// The File remains usable for this session when the handle is unavailable.
		}

		sources.push({ file, sourceHandle });
	}

	if (sources.length > 0) return sources;
	return Array.from(dataTransfer.files).map((file) => ({ file }));
}
