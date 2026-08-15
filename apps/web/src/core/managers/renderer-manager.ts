import type { EditorCore } from "@/core";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type {
	ExportDestination,
	ExportOptions,
	ExportResult,
	ExportStrategy,
} from "@/lib/export";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { FastExporter } from "@/services/renderer/fast-exporter";
import { DirectCopyExporter } from "@/services/renderer/direct-copy-exporter";
import { DirectJoinExporter } from "@/services/renderer/direct-join-exporter";
import type { ExportOutputResult } from "@/services/renderer/export-output";
import { buildScene } from "@/services/renderer/scene-builder";
import { createTimelineAudioBuffer } from "@/lib/media/audio";
import {
	estimateEncodedExportBytes,
	estimateTimelineAudioBufferBytes,
	exceedsCompatibilityBufferLimit,
	exceedsFallbackAudioBufferLimit,
	assessDirectExport,
	getDirectCopyCandidate,
	getFastExportCandidate,
	isDirectExportRequested,
} from "@/lib/export/strategy";
import { EXPORT_TEXT } from "@/lib/export/language";
import { TICKS_PER_SECOND } from "@/lib/wasm";
import { formatTimecode } from "opencut-wasm";
import { downloadBlob } from "@/utils/browser";
import { storageService } from "@/services/storage/service";

type SnapshotResult =
	| { success: true; blob: Blob; filename: string }
	| { success: false; error: string };

export class RendererManager {
	private renderTree: RootNode | null = null;
	private _isDegraded = false;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	get isDegraded(): boolean {
		return this._isDegraded;
	}

	setDegraded(degraded: boolean): void {
		if (this._isDegraded === degraded) return;
		this._isDegraded = degraded;
		this.notify();
	}

	setRenderTree({ renderTree }: { renderTree: RootNode | null }): void {
		this.renderTree = renderTree;
		this.notify();
	}

	getRenderTree(): RootNode | null {
		return this.renderTree;
	}

	async saveSnapshot(): Promise<{ success: boolean; error?: string }> {
		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		downloadBlob({ blob: snapshot.blob, filename: snapshot.filename });
		return { success: true };
	}

	async copySnapshot(): Promise<{ success: boolean; error?: string }> {
		if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
			return {
				success: false,
				error: "Clipboard image copy is not supported in this browser",
			};
		}

		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					[snapshot.blob.type || "image/png"]: snapshot.blob,
				}),
			]);
			return { success: true };
		} catch (error) {
			console.error("Copy snapshot failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	private async createSnapshot(): Promise<SnapshotResult> {
		try {
			const renderTree = this.getRenderTree();
			const activeProject = this.editor.project.getActive();

			if (!renderTree || !activeProject) {
				return { success: false, error: "No project or scene to capture" };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const { canvasSize, fps } = activeProject.settings;
			const renderTime = Math.min(
				this.editor.playback.getCurrentTime(),
				this.editor.timeline.getLastFrameTime(),
			);

			const renderer = new CanvasRenderer({
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
			});

			const tempCanvas = document.createElement("canvas");
			tempCanvas.width = canvasSize.width;
			tempCanvas.height = canvasSize.height;

			await renderer.renderToCanvas({
				node: renderTree,
				time: renderTime,
				targetCanvas: tempCanvas,
			});

			const blob = await new Promise<Blob | null>((resolve) => {
				tempCanvas.toBlob((result) => resolve(result), "image/png");
			});

			if (!blob) {
				return { success: false, error: "Failed to create image" };
			}

			const timecode = formatTimecode({ time: renderTime, rate: fps })!.replace(
				/:/g,
				"-",
			);
			const safeName =
				activeProject.metadata.name.replace(/[<>:"/\\|?*]/g, "-").trim() ||
				"snapshot";
			const filename = `${safeName}-${timecode}.png`;

			return { success: true, blob, filename };
		} catch (error) {
			console.error("Snapshot capture failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	async exportProject({
		options,
		destination,
		onProgress,
		onCancel,
	}: {
		options: ExportOptions;
		destination: ExportDestination;
		onProgress?: ({ progress }: { progress: number }) => void;
		onCancel?: () => boolean;
	}): Promise<ExportResult> {
		const { format, quality, fps, includeAudio } = options;
		const directExportRequested = isDirectExportRequested(options);
		const encodedQuality = quality === "direct" ? null : quality;
		let activeExporter: { cancel: () => void } | null = null;
		let cancelled = false;
		let cancelInterval: ReturnType<typeof setInterval> | null = null;

		try {
			const tracks = this.editor.scenes.getActiveScene().tracks;
			const mediaAssets = this.editor.media.getAssets();
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				await this.cancelDestination({ destination });
				return { success: false, error: EXPORT_TEXT.errors.noActiveProject };
			}

			const duration = this.editor.timeline.getTotalDuration();
			if (duration === 0) {
				await this.cancelDestination({ destination });
				return { success: false, error: EXPORT_TEXT.errors.emptyProject };
			}

			const exportFps = fps ?? activeProject.settings.fps;
			const canvasSize = activeProject.settings.canvasSize;

			const directExportAssessment = directExportRequested
				? assessDirectExport({
						tracks,
						mediaAssets,
						options,
					})
				: null;
			const directExportCandidate = directExportAssessment?.eligible
				? directExportAssessment.candidate
				: null;
			const directCopyCandidate = directExportRequested
				? directExportCandidate?.kind === "copy"
					? directExportCandidate
					: null
				: getDirectCopyCandidate({
						tracks,
						mediaAssets,
						canvasSize,
						duration,
						options,
						ticksPerSecond: TICKS_PER_SECOND,
					});
			const directJoinCandidate =
				directExportCandidate?.kind === "join" ? directExportCandidate : null;

			const checkCancel = () => {
				if (!cancelled && onCancel?.()) {
					cancelled = true;
					activeExporter?.cancel();
				}
			};
			cancelInterval = setInterval(checkCancel, 100);

			if (directExportRequested && destination.kind !== "stream") {
				await this.cancelDestination({ destination });
				return {
					success: false,
					error: EXPORT_TEXT.errors.directExportRequiresFilePicker,
				};
			}

			if (
				directExportRequested &&
				directExportAssessment &&
				!directExportAssessment.eligible
			) {
				await this.cancelDestination({ destination });
				return {
					success: false,
					error:
						EXPORT_TEXT.errors.directExportReasons[
							directExportAssessment.reason
						],
				};
			}

			if (directCopyCandidate) {
				const sourceFile = await this.resolveExportSourceFile({
					projectId: activeProject.metadata.id,
					mediaAsset: directCopyCandidate.mediaAsset,
				});
				const copyCandidate = {
					...directCopyCandidate,
					mediaAsset: { ...directCopyCandidate.mediaAsset, file: sourceFile },
				};

				if (
					destination.kind === "buffer" &&
					exceedsCompatibilityBufferLimit({
						estimatedBytes: sourceFile.size,
					})
				) {
					return {
						success: false,
						error: EXPORT_TEXT.errors.compatibilityBufferTooLarge,
					};
				}

				const strategy: ExportStrategy = "direct-copy";
				const startedAt = this.logExportStageStarted({
					strategy,
					sourceBytes: sourceFile.size,
				});
				const directCopyExporter = new DirectCopyExporter({
					candidate: copyCandidate,
					destination,
				});
				activeExporter = directCopyExporter;
				directCopyExporter.on("progress", (progress) =>
					onProgress?.({ progress }),
				);
				const directCopyResult = await directCopyExporter.export();
				activeExporter = null;

				if (cancelled || !directCopyResult) {
					this.logExportStageFinished({ strategy, startedAt, cancelled: true });
					await this.cancelDestination({ destination });
					return { success: false, cancelled: true };
				}

				const result = await this.completeExport({
					destination,
					result: directCopyResult,
					strategy,
				});
				this.logExportStageFinished({ strategy, startedAt });
				return result;
			}

			if (directJoinCandidate) {
				const sourceFiles = new Map<string, File>();
				const clips: typeof directJoinCandidate.clips = [];
				for (const clip of directJoinCandidate.clips) {
					let sourceFile = sourceFiles.get(clip.mediaAsset.id);
					if (!sourceFile) {
						sourceFile = await this.resolveExportSourceFile({
							projectId: activeProject.metadata.id,
							mediaAsset: clip.mediaAsset,
						});
						sourceFiles.set(clip.mediaAsset.id, sourceFile);
					}
					clips.push({
						...clip,
						mediaAsset: { ...clip.mediaAsset, file: sourceFile },
					});
				}
				const joinCandidate = {
					...directJoinCandidate,
					clips,
					totalSourceBytes: clips.reduce(
						(total, clip) => total + clip.mediaAsset.file.size,
						0,
					),
				};

				const strategy: ExportStrategy = "direct-join";
				const startedAt = this.logExportStageStarted({
					strategy,
					sourceBytes: joinCandidate.totalSourceBytes,
				});
				const directJoinExporter = new DirectJoinExporter({
					candidate: joinCandidate,
					format,
					destination,
					ticksPerSecond: TICKS_PER_SECOND,
				});
				activeExporter = directJoinExporter;
				directJoinExporter.on("progress", (progress) =>
					onProgress?.({ progress }),
				);
				const directJoinResult = await directJoinExporter.export();
				activeExporter = null;

				if (cancelled || !directJoinResult) {
					this.logExportStageFinished({ strategy, startedAt, cancelled: true });
					await this.cancelDestination({ destination });
					return { success: false, cancelled: true };
				}
				if (directJoinResult.kind === "unavailable") {
					console.info(EXPORT_TEXT.diagnostics.strategyUnavailable, {
						strategy,
						reason: directJoinResult.reason,
						elapsedMs: Math.round(performance.now() - startedAt),
					});
					await this.cancelDestination({ destination });
					return {
						success: false,
						error:
							EXPORT_TEXT.errors.directJoinReasons[directJoinResult.reason],
					};
				}

				const result = await this.completeExport({
					destination,
					result: directJoinResult,
					strategy,
				});
				this.logExportStageFinished({ strategy, startedAt });
				return result;
			}

			if (!encodedQuality) {
				await this.cancelDestination({ destination });
				return {
					success: false,
					error: EXPORT_TEXT.errors.directExportUnavailable,
				};
			}

			const fastCandidate = getFastExportCandidate({
				tracks,
				mediaAssets,
				canvasSize,
				duration,
				options,
				ticksPerSecond: TICKS_PER_SECOND,
			});

			if (fastCandidate) {
				if (
					destination.kind === "buffer" &&
					exceedsCompatibilityBufferLimit({
						estimatedBytes: fastCandidate.mediaAsset.file.size,
					})
				) {
					return {
						success: false,
						error: EXPORT_TEXT.errors.compatibilityBufferTooLarge,
					};
				}

				const strategy: ExportStrategy = "remux";
				const startedAt = this.logExportStageStarted({
					strategy,
					sourceBytes: fastCandidate.mediaAsset.file.size,
				});
				const fastExporter = new FastExporter({
					candidate: fastCandidate,
					format,
					destination,
				});
				activeExporter = fastExporter;
				fastExporter.on("progress", (progress) => onProgress?.({ progress }));
				const fastResult = await fastExporter.export();
				activeExporter = null;

				if (cancelled || !fastResult) {
					this.logExportStageFinished({ strategy, startedAt, cancelled: true });
					await this.cancelDestination({ destination });
					return { success: false, cancelled: true };
				}
				if (fastResult.kind !== "unavailable") {
					const result = await this.completeExport({
						destination,
						result: fastResult,
						strategy,
					});
					this.logExportStageFinished({ strategy, startedAt });
					return result;
				}
				console.info(EXPORT_TEXT.diagnostics.strategyUnavailable, {
					strategy,
					elapsedMs: Math.round(performance.now() - startedAt),
				});
			}

			if (
				destination.kind === "buffer" &&
				exceedsCompatibilityBufferLimit({
					estimatedBytes: estimateEncodedExportBytes({
						duration,
						quality: encodedQuality,
						includeAudio: !!includeAudio,
						ticksPerSecond: TICKS_PER_SECOND,
					}),
				})
			) {
				return {
					success: false,
					error: EXPORT_TEXT.errors.compatibilityBufferTooLarge,
				};
			}

			if (
				includeAudio &&
				exceedsFallbackAudioBufferLimit({
					estimatedBytes: estimateTimelineAudioBufferBytes({
						duration,
						ticksPerSecond: TICKS_PER_SECOND,
					}),
				})
			) {
				await this.cancelDestination({ destination });
				return {
					success: false,
					error: EXPORT_TEXT.errors.fallbackAudioTooLarge,
				};
			}

			const strategy: ExportStrategy = "encode";
			const startedAt = this.logExportStageStarted({ strategy });
			let audioBuffer: AudioBuffer | null = null;
			if (includeAudio) {
				onProgress?.({ progress: 0.05 });
				audioBuffer = await createTimelineAudioBuffer({
					tracks,
					mediaAssets,
					duration,
				});
			}

			const scene = buildScene({
				tracks,
				mediaAssets,
				duration,
				canvasSize,
				background: activeProject.settings.background,
			});

			const exporter = new SceneExporter({
				width: canvasSize.width,
				height: canvasSize.height,
				fps: exportFps,
				format,
				quality: encodedQuality,
				shouldIncludeAudio: !!includeAudio,
				audioBuffer: audioBuffer || undefined,
				destination,
			});

			exporter.on("progress", (progress) => {
				const adjustedProgress = includeAudio
					? 0.05 + progress * 0.95
					: progress;
				onProgress?.({ progress: adjustedProgress });
			});

			activeExporter = exporter;
			const result = await exporter.export({ rootNode: scene });
			activeExporter = null;

			if (cancelled || !result) {
				this.logExportStageFinished({ strategy, startedAt, cancelled: true });
				await this.cancelDestination({ destination });
				return { success: false, cancelled: true };
			}

			const completedResult = await this.completeExport({
				destination,
				result,
				strategy,
			});
			this.logExportStageFinished({ strategy, startedAt });
			return completedResult;
		} catch (error) {
			await this.cancelDestination({ destination });
			if (cancelled) return { success: false, cancelled: true };
			console.error(EXPORT_TEXT.diagnostics.exportFailed, error);
			const isUnreadableSource =
				error instanceof DOMException && error.name === "NotReadableError";
			return {
				success: false,
				error: isUnreadableSource
					? EXPORT_TEXT.errors.directSourceUnreadable
					: error instanceof Error
						? error.message
						: EXPORT_TEXT.errors.unknownExport,
			};
		} finally {
			if (cancelInterval) clearInterval(cancelInterval);
		}
	}

	private async resolveExportSourceFile({
		projectId,
		mediaAsset,
	}: {
		projectId: string;
		mediaAsset: { id: string; file: File };
	}): Promise<File> {
		let sourceFile = mediaAsset.file;
		try {
			const persistedSourceFile = await storageService.loadMediaAssetFile({
				projectId,
				id: mediaAsset.id,
			});
			if (persistedSourceFile?.size === sourceFile.size) {
				sourceFile = persistedSourceFile;
			}
		} catch (error) {
			console.warn(EXPORT_TEXT.diagnostics.persistedSourceUnavailable, error);
		}
		return sourceFile;
	}

	private logExportStageStarted({
		strategy,
		sourceBytes,
	}: {
		strategy: ExportStrategy;
		sourceBytes?: number;
	}): number {
		const startedAt = performance.now();
		console.info(EXPORT_TEXT.diagnostics.strategyStarted, {
			strategy,
			sourceBytes,
		});
		return startedAt;
	}

	private logExportStageFinished({
		strategy,
		startedAt,
		cancelled = false,
	}: {
		strategy: ExportStrategy;
		startedAt: number;
		cancelled?: boolean;
	}): void {
		console.info(
			cancelled
				? EXPORT_TEXT.diagnostics.strategyCancelled
				: EXPORT_TEXT.diagnostics.strategyCompleted,
			{
				strategy,
				elapsedMs: Math.round(performance.now() - startedAt),
			},
		);
	}

	private async completeExport({
		destination,
		result,
		strategy,
	}: {
		destination: ExportDestination;
		result: ExportOutputResult;
		strategy: ExportStrategy;
	}): Promise<ExportResult> {
		if (result.kind === "buffer") {
			return { success: true, kind: "buffer", buffer: result.buffer, strategy };
		}
		if (destination.kind !== "stream") {
			throw new Error(EXPORT_TEXT.errors.missingStreamDestination);
		}

		await destination.complete();
		return { success: true, kind: "saved", strategy };
	}

	private async cancelDestination({
		destination,
	}: {
		destination: ExportDestination;
	}): Promise<void> {
		if (destination.kind === "stream") {
			await destination.cancel();
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
