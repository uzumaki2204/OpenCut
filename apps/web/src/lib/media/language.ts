const MEDIA_LANGUAGE = {
	en: {
		assetSingular: "media asset",
		assetPlural: "media assets",
		preparing: "Preparing",
		preparedSingleFallback: "1 media asset is ready",
		preparedNamedSuffix: "is ready",
		preparedMultipleSuffix: "media assets are ready",
		preparedNone: "No media assets were prepared",
		failedPrefix: "Failed to prepare",
		mediaFiles: "Media files",
		ui: {
			video: "Video",
			directOnlyPreview:
				"Preview unavailable. This video can only be used with a compatible Direct export.",
		},
		errors: {
			canvasContext: "Could not create a canvas context.",
			videoTrackMissing: "No video track was found in this file.",
			nativeVideoLoad:
				"The browser could not load this video with its native media decoder.",
			nativeVideoFrame: "The browser could not read a frame from this video.",
			nativeVideoTimeout: "The browser timed out while reading a video frame.",
			nativeVideoDisposed: "The native video preview source has been disposed.",
		},
		upload: {
			directOnlySingle: (name: string) =>
				`${name} is ready for Direct export, but this browser cannot show its thumbnail or preview.`,
			directOnlyMultiple: (count: number) =>
				`${count} videos are ready for Direct export, but this browser cannot show their thumbnails or previews.`,
		},
		handleReadySuffix: "is ready without a browser-storage copy",
		handleMultipleSuffix:
			"media assets are ready without browser-storage copies",
		sessionReadySuffix:
			"is ready for this session. Re-import it after reloading the project",
		sessionSingleFallback:
			"1 large media asset is ready for this session and must be re-imported after reloading",
		sessionMultipleSuffix:
			"large media assets are ready for this session and must be re-imported after reloading",
		diagnostics: {
			filePickerFallback:
				"File System Access picker failed; using the compatibility file input:",
			webCodecsThumbnailFailed:
				"WebCodecs thumbnail decoding failed; trying the native video decoder:",
			nativeVideoUnavailable: "Native video preview is unavailable:",
			videoProcessingFailed: "Video processing failed:",
			videoSinkInitializationFailed: "Failed to initialize video preview:",
			videoSeekFailed: "Failed to seek video preview:",
			videoPrefetchFailed: "Failed to prefetch a video frame:",
			videoIteratorFailed: "Video frame iteration failed; restarting:",
			videoSeekPrefetchFailed: "Failed to prefetch after seeking:",
		},
	},
} as const;

export const MEDIA_TEXT = MEDIA_LANGUAGE.en;

export function getMediaAssetLabel({ count }: { count: number }): string {
	return count === 1 ? MEDIA_TEXT.assetSingular : MEDIA_TEXT.assetPlural;
}

export function getMediaPreparingMessage({ count }: { count: number }): string {
	return `${MEDIA_TEXT.preparing} ${getMediaAssetLabel({ count })}...`;
}

export function getMediaFailureMessage({ count }: { count: number }): string {
	return `${MEDIA_TEXT.failedPrefix} ${getMediaAssetLabel({ count })}`;
}
