import type { MediaAssetData } from "@/services/storage/types";

export type MediaType = "image" | "video" | "audio";

export type MediaPreviewMode = "webcodecs" | "native" | "unavailable";

export interface MediaFileSource {
	file: File;
	sourceHandle?: FileSystemFileHandle;
}

export interface MediaAsset
	extends Omit<MediaAssetData, "size" | "lastModified"> {
	file: File;
	url?: string;
	previewMode?: MediaPreviewMode;
}
