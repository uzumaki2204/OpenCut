import {
	ALL_FORMATS,
	BlobSource,
	Input,
	VideoSampleSink,
	type WrappedCanvas,
} from "mediabunny";
import { MEDIA_TEXT } from "./language";
import type { MediaPreviewMode } from "./types";

const DEFAULT_FRAME_DURATION = 1 / 30;
const NATIVE_VIDEO_TIMEOUT_MS = 10_000;
const VIDEO_FRAME_CALLBACK_GRACE_MS = 250;
const NATIVE_CANVAS_POOL_SIZE = 3;
const THUMBNAIL_MAX_WIDTH = 1280;
const THUMBNAIL_MAX_HEIGHT = 720;

export interface VideoInspection {
	duration: number;
	width: number;
	height: number;
	fps: number;
	hasAudio: boolean;
	videoCodec?: string;
	videoCodecString?: string;
	previewMode: MediaPreviewMode;
	thumbnailUrl?: string;
}

export interface NativeVideoEnvironment {
	createVideo: () => HTMLVideoElement;
	createCanvas: () => HTMLCanvasElement;
	createObjectUrl: (file: File) => string;
	revokeObjectUrl: (url: string) => void;
}

const browserNativeVideoEnvironment: NativeVideoEnvironment = {
	createVideo: () => document.createElement("video"),
	createCanvas: () => document.createElement("canvas"),
	createObjectUrl: (file) => URL.createObjectURL(file),
	revokeObjectUrl: (url) => URL.revokeObjectURL(url),
};

function createTimeoutError(): Error {
	return new Error(MEDIA_TEXT.errors.nativeVideoTimeout);
}

function waitForMediaState({
	video,
	successEvent,
	isReady,
	timeoutMs,
	signal,
}: {
	video: HTMLVideoElement;
	successEvent: "loadedmetadata" | "loadeddata" | "seeked";
	isReady: () => boolean;
	timeoutMs: number;
	signal: AbortSignal;
}): Promise<void> {
	if (isReady()) return Promise.resolve();

	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timeoutId);
			video.removeEventListener(successEvent, onSuccess);
			video.removeEventListener("error", onError);
			signal.removeEventListener("abort", onAbort);
		};
		const onSuccess = () => {
			if (!isReady()) return;
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			reject(new Error(MEDIA_TEXT.errors.nativeVideoLoad));
		};
		const onAbort = () => {
			cleanup();
			reject(new Error(MEDIA_TEXT.errors.nativeVideoDisposed));
		};
		const timeoutId = setTimeout(() => {
			cleanup();
			reject(createTimeoutError());
		}, timeoutMs);

		video.addEventListener(successEvent, onSuccess);
		video.addEventListener("error", onError);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function waitForPresentedFrame({
	video,
	signal,
}: {
	video: HTMLVideoElement;
	signal: AbortSignal;
}): Promise<void> {
	if (typeof video.requestVideoFrameCallback !== "function") {
		return Promise.resolve();
	}

	return new Promise((resolve, reject) => {
		let callbackId: number | null = null;
		const cleanup = () => {
			clearTimeout(timeoutId);
			if (
				callbackId !== null &&
				typeof video.cancelVideoFrameCallback === "function"
			) {
				video.cancelVideoFrameCallback(callbackId);
			}
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new Error(MEDIA_TEXT.errors.nativeVideoDisposed));
		};
		const timeoutId = setTimeout(() => {
			cleanup();
			resolve();
		}, VIDEO_FRAME_CALLBACK_GRACE_MS);

		callbackId = video.requestVideoFrameCallback(() => {
			callbackId = null;
			cleanup();
			resolve();
		});
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function cleanupNativeVideo({
	video,
	objectUrl,
	environment,
}: {
	video: HTMLVideoElement;
	objectUrl: string;
	environment: NativeVideoEnvironment;
}): void {
	video.pause();
	video.removeAttribute("src");
	video.load();
	environment.revokeObjectUrl(objectUrl);
}

export function clampVideoPreviewTime({
	time,
	duration,
	frameDuration,
}: {
	time: number;
	duration: number;
	frameDuration: number;
}): number {
	const safeTime = Number.isFinite(time) ? Math.max(0, time) : 0;
	if (!Number.isFinite(duration) || duration <= 0) return safeTime;
	return Math.min(safeTime, Math.max(0, duration - frameDuration / 2));
}

export class NativeVideoFrameSource {
	private readonly abortController = new AbortController();
	private operationChain: Promise<void> = Promise.resolve();
	private disposed = false;
	private nextCanvasIndex = 0;

	private constructor(
		private readonly video: HTMLVideoElement,
		private readonly canvasPool: Array<{
			canvas: HTMLCanvasElement;
			context: CanvasRenderingContext2D;
		}>,
		private readonly objectUrl: string,
		private readonly environment: NativeVideoEnvironment,
		private readonly frameDuration: number,
		private readonly timeoutMs: number,
	) {}

	static async create({
		file,
		fps,
		timeoutMs = NATIVE_VIDEO_TIMEOUT_MS,
		environment = browserNativeVideoEnvironment,
	}: {
		file: File;
		fps?: number;
		timeoutMs?: number;
		environment?: NativeVideoEnvironment;
	}): Promise<NativeVideoFrameSource> {
		const video = environment.createVideo();
		const objectUrl = environment.createObjectUrl(file);
		const abortController = new AbortController();

		video.preload = "auto";
		video.muted = true;
		video.playsInline = true;
		video.src = objectUrl;

		try {
			const metadataReady = waitForMediaState({
				video,
				successEvent: "loadedmetadata",
				isReady: () => video.readyState >= 1,
				timeoutMs,
				signal: abortController.signal,
			});
			video.load();
			await metadataReady;

			await waitForMediaState({
				video,
				successEvent: "loadeddata",
				isReady: () => video.readyState >= 2,
				timeoutMs,
				signal: abortController.signal,
			});

			if (video.videoWidth <= 0 || video.videoHeight <= 0) {
				throw new Error(MEDIA_TEXT.errors.nativeVideoFrame);
			}

			const canvasPool = Array.from({ length: NATIVE_CANVAS_POOL_SIZE }, () => {
				const canvas = environment.createCanvas();
				canvas.width = video.videoWidth;
				canvas.height = video.videoHeight;
				const context = canvas.getContext("2d");
				if (!context) {
					throw new Error(MEDIA_TEXT.errors.canvasContext);
				}
				return { canvas, context };
			});

			const frameDuration =
				fps && Number.isFinite(fps) && fps > 0
					? 1 / fps
					: DEFAULT_FRAME_DURATION;
			return new NativeVideoFrameSource(
				video,
				canvasPool,
				objectUrl,
				environment,
				frameDuration,
				timeoutMs,
			);
		} catch (error) {
			abortController.abort();
			cleanupNativeVideo({ video, objectUrl, environment });
			throw error;
		}
	}

	getFrame({ time }: { time: number }): Promise<WrappedCanvas> {
		const operation = this.operationChain.then(() =>
			this.renderFrame({ time }),
		);
		this.operationChain = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private async renderFrame({
		time,
	}: {
		time: number;
	}): Promise<WrappedCanvas> {
		if (this.disposed) {
			throw new Error(MEDIA_TEXT.errors.nativeVideoDisposed);
		}

		const targetTime = clampVideoPreviewTime({
			time,
			duration: this.video.duration,
			frameDuration: this.frameDuration,
		});
		const seekTolerance = Math.max(0.001, this.frameDuration / 2);

		if (Math.abs(this.video.currentTime - targetTime) > seekTolerance) {
			const seeked = waitForMediaState({
				video: this.video,
				successEvent: "seeked",
				isReady: () =>
					this.video.readyState >= 2 &&
					Math.abs(this.video.currentTime - targetTime) <= seekTolerance,
				timeoutMs: this.timeoutMs,
				signal: this.abortController.signal,
			});
			const presentedFrame = waitForPresentedFrame({
				video: this.video,
				signal: this.abortController.signal,
			});
			this.video.currentTime = targetTime;
			await seeked;
			await presentedFrame;
		}

		const frameCanvas = this.canvasPool[this.nextCanvasIndex];
		if (!frameCanvas) throw new Error(MEDIA_TEXT.errors.canvasContext);
		this.nextCanvasIndex = (this.nextCanvasIndex + 1) % this.canvasPool.length;
		frameCanvas.context.drawImage(
			this.video,
			0,
			0,
			frameCanvas.canvas.width,
			frameCanvas.canvas.height,
		);

		return {
			canvas: frameCanvas.canvas,
			timestamp: this.video.currentTime,
			duration: this.frameDuration,
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.abortController.abort();
		cleanupNativeVideo({
			video: this.video,
			objectUrl: this.objectUrl,
			environment: this.environment,
		});
	}
}

function renderThumbnailDataUrl({
	width,
	height,
	draw,
}: {
	width: number;
	height: number;
	draw: (
		context: CanvasRenderingContext2D,
		width: number,
		height: number,
	) => void;
}): string {
	const scale = Math.min(
		1,
		THUMBNAIL_MAX_WIDTH / width,
		THUMBNAIL_MAX_HEIGHT / height,
	);
	const targetWidth = Math.max(1, Math.round(width * scale));
	const targetHeight = Math.max(1, Math.round(height * scale));
	const canvas = document.createElement("canvas");
	canvas.width = targetWidth;
	canvas.height = targetHeight;
	const context = canvas.getContext("2d");
	if (!context) throw new Error(MEDIA_TEXT.errors.canvasContext);
	draw(context, targetWidth, targetHeight);
	return canvas.toDataURL("image/jpeg", 0.8);
}

const inspectionCache = new WeakMap<File, Promise<VideoInspection>>();

export function inspectVideoFile({
	videoFile,
}: {
	videoFile: File;
}): Promise<VideoInspection> {
	const cached = inspectionCache.get(videoFile);
	if (cached) return cached;

	const inspection = inspectVideoFileUncached({ videoFile });
	inspectionCache.set(videoFile, inspection);
	void inspection.catch(() => inspectionCache.delete(videoFile));
	return inspection;
}

async function inspectVideoFileUncached({
	videoFile,
}: {
	videoFile: File;
}): Promise<VideoInspection> {
	const input = new Input({
		source: new BlobSource(videoFile),
		formats: ALL_FORMATS,
	});

	try {
		const duration = await input.computeDuration();
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) throw new Error(MEDIA_TEXT.errors.videoTrackMissing);

		const packetStats = await videoTrack.computePacketStats(100);
		const fps =
			Number.isFinite(packetStats.averagePacketRate) &&
			packetStats.averagePacketRate > 0
				? packetStats.averagePacketRate
				: 30;
		const audioTrack = await input.getPrimaryAudioTrack();
		const videoCodecString =
			(await videoTrack.getCodecParameterString().catch(() => null)) ??
			undefined;
		const baseInspection = {
			duration,
			width: videoTrack.displayWidth,
			height: videoTrack.displayHeight,
			fps,
			hasAudio: audioTrack !== null,
			videoCodec: videoTrack.codec ?? undefined,
			videoCodecString,
		};
		const thumbnailTime = clampVideoPreviewTime({
			time: 1,
			duration,
			frameDuration: 1 / fps,
		});

		if (await videoTrack.canDecode()) {
			try {
				const sample = await new VideoSampleSink(videoTrack).getSample(
					thumbnailTime,
				);
				if (!sample) throw new Error(MEDIA_TEXT.errors.nativeVideoFrame);

				try {
					return {
						...baseInspection,
						previewMode: "webcodecs",
						thumbnailUrl: renderThumbnailDataUrl({
							width: videoTrack.displayWidth,
							height: videoTrack.displayHeight,
							draw: (context, width, height) =>
								sample.draw(context, 0, 0, width, height),
						}),
					};
				} finally {
					sample.close();
				}
			} catch (error) {
				console.warn(MEDIA_TEXT.diagnostics.webCodecsThumbnailFailed, error);
			}
		}

		try {
			const nativeSource = await NativeVideoFrameSource.create({
				file: videoFile,
				fps,
			});
			try {
				const frame = await nativeSource.getFrame({ time: thumbnailTime });
				return {
					...baseInspection,
					previewMode: "native",
					thumbnailUrl: renderThumbnailDataUrl({
						width: frame.canvas.width,
						height: frame.canvas.height,
						draw: (context, width, height) =>
							context.drawImage(frame.canvas, 0, 0, width, height),
					}),
				};
			} finally {
				nativeSource.dispose();
			}
		} catch (error) {
			console.warn(MEDIA_TEXT.diagnostics.nativeVideoUnavailable, error);
			return { ...baseInspection, previewMode: "unavailable" };
		}
	} finally {
		input.dispose();
	}
}

export function getMediaPreviewSummary({
	assets,
}: {
	assets: Array<{ previewMode?: MediaPreviewMode }>;
}): { nativePreviewCount: number; unavailablePreviewCount: number } {
	return {
		nativePreviewCount: assets.filter((asset) => asset.previewMode === "native")
			.length,
		unavailablePreviewCount: assets.filter(
			(asset) => asset.previewMode === "unavailable",
		).length,
	};
}
