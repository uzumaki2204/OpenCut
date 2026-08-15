import type { MediaStorageMode } from "@/services/storage/types";

export const MAX_OPFS_MEDIA_BYTES = 512 * 1024 * 1024;

export function getMediaStorageMode({
	file,
	sourceHandle,
}: {
	file: File;
	sourceHandle?: FileSystemFileHandle;
}): MediaStorageMode {
	if (file.size <= MAX_OPFS_MEDIA_BYTES) return "opfs";
	return sourceHandle ? "handle" : "session";
}

export function getMediaStorageSummary({
	assets,
}: {
	assets: Array<{ storageMode?: MediaStorageMode }>;
}): { handleLinkedCount: number; sessionOnlyCount: number } {
	return {
		handleLinkedCount: assets.filter((asset) => asset.storageMode === "handle")
			.length,
		sessionOnlyCount: assets.filter((asset) => asset.storageMode === "session")
			.length,
	};
}
