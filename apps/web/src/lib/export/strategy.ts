import type { FrameRate } from "opencut-wasm";
import type { EncodedExportQuality, ExportOptions } from ".";
import type { MediaAsset } from "@/lib/media/types";
import type { TCanvasSize } from "@/lib/project/types";
import type { SceneTracks, VideoElement } from "@/lib/timeline";
import { frameRateToFloat } from "@/lib/fps/utils";

const MAX_COMPATIBILITY_BUFFER_BYTES = 512 * 1024 * 1024;
const MAX_FALLBACK_AUDIO_BUFFER_BYTES = 512 * 1024 * 1024;
const ESTIMATED_VIDEO_BITRATES: Record<EncodedExportQuality, number> = {
	low: 2_000_000,
	medium: 5_000_000,
	high: 10_000_000,
	very_high: 20_000_000,
};
const ESTIMATED_AUDIO_BITRATE = 192_000;

export interface FastExportCandidate {
	element: VideoElement;
	mediaAsset: MediaAsset;
	trimEndSeconds: number;
	copyAudio: boolean;
}

export interface DirectCopyExportCandidate {
	kind: "copy";
	mediaAsset: MediaAsset;
}

export interface DirectJoinExportClip {
	element: VideoElement;
	mediaAsset: MediaAsset;
	outputStartTicks: number;
	trimStartTicks: number;
	durationTicks: number;
}

export interface DirectJoinExportCandidate {
	kind: "join";
	clips: DirectJoinExportClip[];
	totalSourceBytes: number;
}

export type DirectExportCandidate =
	| DirectCopyExportCandidate
	| DirectJoinExportCandidate;

export type DirectExportRejectionReason =
	| "videoRequired"
	| "missingSource"
	| "formatMismatch"
	| "unsupportedTimeline";

export type DirectExportAssessment =
	| { eligible: true; candidate: DirectExportCandidate }
	| { eligible: false; reason: DirectExportRejectionReason };

export function isDirectExportRequested({
	quality,
}: Pick<ExportOptions, "quality">): boolean {
	return quality === "direct";
}

function hasAnimations({ element }: { element: VideoElement }): boolean {
	return (
		!!element.animations &&
		(Object.keys(element.animations.bindings).length > 0 ||
			Object.keys(element.animations.channels).length > 0)
	);
}

function hasIdentityTransform({ element }: { element: VideoElement }): boolean {
	return (
		element.transform.scaleX === 1 &&
		element.transform.scaleY === 1 &&
		element.transform.position.x === 0 &&
		element.transform.position.y === 0 &&
		element.transform.rotate === 0
	);
}

function hasExactlyOneTimelineElement({
	tracks,
}: {
	tracks: SceneTracks;
}): boolean {
	const elementCount = [tracks.main, ...tracks.overlay, ...tracks.audio].reduce(
		(count, track) => count + track.elements.length,
		0,
	);
	return elementCount === 1;
}

function getTimelineVideoElements({
	tracks,
}: {
	tracks: SceneTracks;
}): VideoElement[] {
	const elements: VideoElement[] = [];

	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const element of track.elements) {
			if (element.type === "video") elements.push(element);
		}
	}

	return elements;
}

function frameRatesMatch({
	exportFps,
	mediaFps,
}: {
	exportFps?: FrameRate;
	mediaFps?: number;
}): boolean {
	if (!exportFps || !mediaFps) return true;
	return Math.abs(frameRateToFloat(exportFps) - mediaFps) < 0.01;
}

function sourceContainerMatchesExport({
	mediaAsset,
	format,
}: {
	mediaAsset: MediaAsset;
	format: ExportOptions["format"];
}): boolean {
	const originalExtension = mediaAsset.name.split(".").pop()?.toLowerCase();
	const storedFileExtension = mediaAsset.file.name
		.split(".")
		.pop()
		?.toLowerCase();
	const sourceExtension =
		originalExtension === mediaAsset.name.toLowerCase()
			? storedFileExtension
			: originalExtension;
	return sourceExtension === format;
}

function getDirectCopySourceIdentity({
	mediaAsset,
}: {
	mediaAsset: MediaAsset;
}): string {
	return [
		mediaAsset.name.trim().toLowerCase(),
		mediaAsset.file.size,
		mediaAsset.duration ?? "",
		mediaAsset.width ?? "",
		mediaAsset.height ?? "",
		mediaAsset.fps ?? "",
	].join("\0");
}

function canJoinVideoElement({ element }: { element: VideoElement }): boolean {
	return (
		!element.hidden &&
		element.duration > 0 &&
		element.trimStart >= 0 &&
		(!element.retime || element.retime.rate === 1) &&
		hasIdentityTransform({ element }) &&
		element.opacity === 1 &&
		(element.blendMode ?? "normal") === "normal" &&
		!hasAnimations({ element }) &&
		(element.effects?.length ?? 0) === 0 &&
		(element.masks?.length ?? 0) === 0 &&
		element.muted !== true &&
		element.isSourceAudioEnabled !== false &&
		(element.volume ?? 0) === 0
	);
}

export function getDirectCopyCandidate({
	tracks,
	mediaAssets,
	canvasSize,
	duration,
	options,
	ticksPerSecond,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	canvasSize: TCanvasSize;
	duration: number;
	options: ExportOptions;
	ticksPerSecond: number;
}): DirectCopyExportCandidate | null {
	if (isDirectExportRequested(options)) {
		const assessment = assessDirectExport({
			tracks,
			mediaAssets,
			options,
		});
		return assessment.eligible && assessment.candidate.kind === "copy"
			? assessment.candidate
			: null;
	}

	const candidate = getFastExportCandidate({
		tracks,
		mediaAssets,
		canvasSize,
		duration,
		options,
		ticksPerSecond,
	});
	if (!candidate) return null;

	const { element, mediaAsset } = candidate;
	if (element.trimStart !== 0 || element.trimEnd !== 0) return null;
	if (
		element.sourceDuration !== undefined &&
		element.duration !== element.sourceDuration
	) {
		return null;
	}
	if (
		!sourceContainerMatchesExport({
			mediaAsset,
			format: options.format,
		})
	) {
		return null;
	}

	// Unknown audio metadata is treated as potentially containing audio.
	if (mediaAsset.hasAudio !== false && !candidate.copyAudio) return null;

	return { kind: "copy", mediaAsset };
}

export function assessDirectExport({
	tracks,
	mediaAssets,
	options,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	options: ExportOptions;
}): DirectExportAssessment {
	const videoElements = getTimelineVideoElements({ tracks });
	if (videoElements.length === 0) {
		return { eligible: false, reason: "videoRequired" };
	}
	const mediaAssetsById = new Map(
		mediaAssets.map((mediaAsset) => [mediaAsset.id, mediaAsset]),
	);
	const sourceMediaAssets = videoElements.map((element) =>
		mediaAssetsById.get(element.mediaId),
	);
	if (
		sourceMediaAssets.some(
			(mediaAsset) => !mediaAsset || mediaAsset.type !== "video",
		)
	) {
		return { eligible: false, reason: "missingSource" };
	}

	const videoMediaAssets = sourceMediaAssets as MediaAsset[];
	const sourceIdentities = new Set(
		videoMediaAssets.map((mediaAsset) =>
			getDirectCopySourceIdentity({ mediaAsset }),
		),
	);
	const mediaAsset = videoMediaAssets[0];
	if (!mediaAsset) {
		return { eligible: false, reason: "missingSource" };
	}

	if (
		videoMediaAssets.some(
			(sourceMediaAsset) =>
				!sourceContainerMatchesExport({
					mediaAsset: sourceMediaAsset,
					format: options.format,
				}),
		)
	) {
		return { eligible: false, reason: "formatMismatch" };
	}

	if (sourceIdentities.size === 1) {
		// Direct copy preserves the original source and intentionally ignores edits.
		return { eligible: true, candidate: { kind: "copy", mediaAsset } };
	}

	const hasNonMainElements = [...tracks.overlay, ...tracks.audio].some(
		(track) => track.elements.length > 0,
	);
	if (
		tracks.main.hidden ||
		tracks.main.muted ||
		hasNonMainElements ||
		tracks.main.elements.length !== videoElements.length
	) {
		return { eligible: false, reason: "unsupportedTimeline" };
	}

	const sortedElements = [...tracks.main.elements].sort(
		(a, b) => a.startTime - b.startTime,
	);
	const clips: DirectJoinExportClip[] = [];
	let expectedStartTicks = 0;

	for (const element of sortedElements) {
		if (
			element.type !== "video" ||
			!canJoinVideoElement({ element }) ||
			Math.abs(element.startTime - expectedStartTicks) > 1
		) {
			return { eligible: false, reason: "unsupportedTimeline" };
		}

		const sourceMediaAsset = mediaAssetsById.get(element.mediaId);
		if (!sourceMediaAsset || sourceMediaAsset.type !== "video") {
			return { eligible: false, reason: "missingSource" };
		}
		if (
			element.sourceDuration !== undefined &&
			element.trimStart + element.duration > element.sourceDuration + 1
		) {
			return { eligible: false, reason: "unsupportedTimeline" };
		}

		clips.push({
			element,
			mediaAsset: sourceMediaAsset,
			outputStartTicks: expectedStartTicks,
			trimStartTicks: element.trimStart,
			durationTicks: element.duration,
		});
		expectedStartTicks += element.duration;
	}

	return {
		eligible: true,
		candidate: {
			kind: "join",
			clips,
			totalSourceBytes: clips.reduce(
				(total, clip) => total + clip.mediaAsset.file.size,
				0,
			),
		},
	};
}

export function getFastExportCandidate({
	tracks,
	mediaAssets,
	canvasSize,
	duration,
	options,
	ticksPerSecond,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	canvasSize: TCanvasSize;
	duration: number;
	options: ExportOptions;
	ticksPerSecond: number;
}): FastExportCandidate | null {
	if (!hasExactlyOneTimelineElement({ tracks }) || tracks.main.hidden)
		return null;

	const element = tracks.main.elements[0];
	if (!element || element.type !== "video" || element.hidden) return null;
	if (element.startTime !== 0 || element.duration !== duration) return null;

	// mediabunny 1.x re-encodes a non-zero trim start to keep the first frame exact.
	if (element.trimStart !== 0) return null;
	if (element.retime && element.retime.rate !== 1) return null;
	if (!hasIdentityTransform({ element })) return null;
	if (element.opacity !== 1 || (element.blendMode ?? "normal") !== "normal") {
		return null;
	}
	if (hasAnimations({ element })) return null;
	if ((element.effects?.length ?? 0) > 0 || (element.masks?.length ?? 0) > 0) {
		return null;
	}

	const mediaAsset = mediaAssets.find((asset) => asset.id === element.mediaId);
	if (!mediaAsset || mediaAsset.type !== "video") return null;
	if (
		mediaAsset.width !== canvasSize.width ||
		mediaAsset.height !== canvasSize.height
	) {
		return null;
	}
	if (!frameRatesMatch({ exportFps: options.fps, mediaFps: mediaAsset.fps })) {
		return null;
	}

	const sourceAudioIsAudible =
		!tracks.main.muted &&
		element.muted !== true &&
		element.isSourceAudioEnabled !== false;
	if (
		options.includeAudio &&
		sourceAudioIsAudible &&
		(element.volume ?? 0) !== 0
	) {
		return null;
	}

	return {
		element,
		mediaAsset,
		trimEndSeconds: (element.trimStart + element.duration) / ticksPerSecond,
		copyAudio: !!options.includeAudio && sourceAudioIsAudible,
	};
}

export function estimateEncodedExportBytes({
	duration,
	quality,
	includeAudio,
	ticksPerSecond,
}: {
	duration: number;
	quality: EncodedExportQuality;
	includeAudio: boolean;
	ticksPerSecond: number;
}): number {
	const durationSeconds = duration / ticksPerSecond;
	const bitsPerSecond =
		ESTIMATED_VIDEO_BITRATES[quality] +
		(includeAudio ? ESTIMATED_AUDIO_BITRATE : 0);
	return (durationSeconds * bitsPerSecond) / 8;
}

export function exceedsCompatibilityBufferLimit({
	estimatedBytes,
}: {
	estimatedBytes: number;
}): boolean {
	return estimatedBytes > MAX_COMPATIBILITY_BUFFER_BYTES;
}

export function estimateTimelineAudioBufferBytes({
	duration,
	ticksPerSecond,
	sampleRate = 44_100,
	numberOfChannels = 2,
}: {
	duration: number;
	ticksPerSecond: number;
	sampleRate?: number;
	numberOfChannels?: number;
}): number {
	const durationSeconds = duration / ticksPerSecond;
	return (
		Math.ceil(durationSeconds * sampleRate) *
		numberOfChannels *
		Float32Array.BYTES_PER_ELEMENT
	);
}

export function exceedsFallbackAudioBufferLimit({
	estimatedBytes,
}: {
	estimatedBytes: number;
}): boolean {
	return estimatedBytes > MAX_FALLBACK_AUDIO_BUFFER_BYTES;
}
