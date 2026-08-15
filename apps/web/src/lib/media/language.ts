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
