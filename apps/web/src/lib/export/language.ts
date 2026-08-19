export const EXPORT_LANGUAGE = {
	en: {
		ui: {
			button: "Export",
			exportProject: "Export project",
			exportingProject: "Exporting project",
			format: "Format",
			mp4: "MP4 (H.264) - Better compatibility",
			webm: "WebM (VP9) - Smaller file size",
			quality: "Quality",
			qualityDirect: "Direct export - No encoding",
			qualityDirectHelp:
				"Copies or joins compatible clips. Cuts between keyframes are snapped earlier.",
			qualityLow: "Low - Smallest file size",
			qualityMedium: "Medium - Balanced",
			qualityHigh: "High - Recommended",
			qualityVeryHigh: "Very high - Largest file size",
			audio: "Audio",
			includeAudio: "Include audio in export",
			cancel: "Cancel",
			exportFailed: "Export failed",
			copy: "Copy",
			retry: "Retry",
			progressComplete: "100%",
			fileTypeVideo: "Video",
			defaultFilename: "video",
			directFilenameSuffix: "-direct",
		},
		errors: {
			noActiveProject: "No active project",
			emptyProject: "Project is empty",
			unknown: "Unknown error occurred",
			unknownExport: "Unknown export error",
			missingBuffer: "Export failed to produce a buffer",
			missingStreamDestination: "Export stream destination is unavailable",
			invalidFlushThreshold:
				"The export write buffer size must be greater than zero.",
			filePicker: "Could not open the export file destination",
			directExportRequiresFilePicker:
				"Direct export requires direct file saving. Use a Chromium-based browser with file-picker support.",
			directExportUnavailable:
				"Direct export is unavailable for this timeline.",
			directExportReasons: {
				videoRequired: "Direct export requires one video clip.",
				missingSource:
					"The source video is unavailable. Re-import it and try again.",
				formatMismatch:
					"The selected Direct export format must match the source video container.",
				unsupportedTimeline:
					"Direct Join requires consecutive video clips on the main track without gaps, overlaps, effects, transforms, speed changes, or audio changes.",
			},
			directJoinReasons: {
				unsupportedCodec:
					"One or more source codecs cannot be copied into the selected output format.",
				incompatibleVideo:
					"These videos cannot be joined without encoding because their codec configuration, resolution, or rotation differs.",
				incompatibleAudio:
					"These videos cannot be joined without encoding because their audio codec, sample rate, or channel count differs.",
				invalidSource:
					"One or more source videos could not be read as a Direct Join input.",
				writeFailed:
					"Direct Join could not write a valid output file from these source videos.",
			},
			directExportCannotOverwriteSource:
				"Direct export cannot overwrite the source video. Choose a different filename or folder.",
			directSourceUnreadable:
				"The source video could not be read. Wait for the import to finish, then retry and save to a different filename.",
			compatibilityBufferTooLarge:
				"This browser cannot stream a large export directly to disk. Use a Chromium-based browser with file saving support, or export a shorter project.",
			fallbackAudioTooLarge:
				"This project requires an audio mixdown that is too large for browser memory. Remove complex audio edits or export without audio to avoid a browser crash.",
			encodedExportVideoUnavailable: (name: string) =>
				`Encoded export cannot decode ${name} in this browser. Use a compatible Direct export or convert the source video to H.264 first.`,
		},
		warnings: {
			directJoinKeyframeSnap: ({
				clipCount,
				maxSnapMilliseconds,
			}: {
				clipCount: number;
				maxSnapMilliseconds: number;
			}) =>
				`Direct export moved ${clipCount} cut(s) to an earlier keyframe, by up to ${Math.round(maxSnapMilliseconds)} ms.`,
		},
		diagnostics: {
			exportFailed: "Export failed:",
			strategyStarted: "Export strategy started:",
			strategyCompleted: "Export strategy completed:",
			strategyUnavailable: "Export strategy unavailable:",
			strategyCancelled: "Export strategy cancelled:",
			persistedSourceUnavailable:
				"Stored source snapshot is unavailable; using the imported file reference:",
			directJoinPerformance: "Direct Join performance:",
			directJoinKeyframeSnap: "Direct Join keyframe snap:",
			destinationWriteCompleted: "Export destination write completed:",
		},
	},
} as const;

export const EXPORT_TEXT = EXPORT_LANGUAGE.en;
