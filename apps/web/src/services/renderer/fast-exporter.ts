import EventEmitter from "eventemitter3";
import {
	ALL_FORMATS,
	BlobSource,
	Conversion,
	ConversionCanceledError,
	Input,
	Output,
} from "mediabunny";
import type { ExportDestination, ExportFormat } from "@/lib/export";
import type { FastExportCandidate } from "@/lib/export/strategy";
import {
	createExportOutputFormat,
	createExportOutputTarget,
	getExportOutputResult,
	type ExportOutputResult,
} from "./export-output";

type FastExporterEvents = {
	progress: [progress: number];
};

export type FastExporterResult = ExportOutputResult | { kind: "unavailable" };

const MP4_VIDEO_CODECS = new Set(["avc"]);
const MP4_AUDIO_CODECS = new Set(["aac"]);
const WEBM_VIDEO_CODECS = new Set(["vp8", "vp9", "av1"]);
const WEBM_AUDIO_CODECS = new Set(["opus", "vorbis"]);

export class FastExporter extends EventEmitter<FastExporterEvents> {
	private conversion: Conversion | null = null;
	private isCancelled = false;

	constructor(
		private params: {
			candidate: FastExportCandidate;
			format: ExportFormat;
			destination: ExportDestination;
		},
	) {
		super();
	}

	cancel(): void {
		this.isCancelled = true;
		void this.conversion?.cancel();
	}

	async export(): Promise<FastExporterResult | null> {
		const { candidate, format, destination } = this.params;
		const input = new Input({
			source: new BlobSource(candidate.mediaAsset.file),
			formats: ALL_FORMATS,
		});

		try {
			if (!(await this.canCopyPackets({ input }))) {
				return { kind: "unavailable" };
			}
			if (this.isCancelled) return null;

			const target = createExportOutputTarget({ destination });
			const output = new Output({
				format: createExportOutputFormat({ format, destination }),
				target,
			});
			const conversion = await Conversion.init({
				input,
				output,
				trim: { start: 0, end: candidate.trimEndSeconds },
				video: (_track, index) =>
					index === 1 ? { forceTranscode: false } : { discard: true },
				audio: (_track, index) =>
					candidate.copyAudio && index === 1
						? { forceTranscode: false }
						: { discard: true },
				showWarnings: false,
			});
			this.conversion = conversion;

			if (!conversion.isValid) return { kind: "unavailable" };
			if (this.isCancelled) {
				await conversion.cancel();
				return null;
			}

			conversion.onProgress = (progress) => this.emit("progress", progress);
			await conversion.execute();
			return getExportOutputResult({ target });
		} catch (error) {
			if (error instanceof ConversionCanceledError || this.isCancelled) {
				return null;
			}
			throw error;
		} finally {
			this.conversion = null;
			input.dispose();
		}
	}

	private async canCopyPackets({ input }: { input: Input }): Promise<boolean> {
		const { candidate, format } = this.params;
		const videoTracks = await input.getVideoTracks();
		if (videoTracks.length !== 1) return false;

		const videoTrack = videoTracks[0];
		const allowedVideoCodecs =
			format === "webm" ? WEBM_VIDEO_CODECS : MP4_VIDEO_CODECS;
		if (!videoTrack?.codec || !allowedVideoCodecs.has(videoTrack.codec)) {
			return false;
		}
		if ((await videoTrack.getFirstTimestamp()) < 0) return false;
		if (await videoTrack.canBeTransparent()) return false;
		if (format === "webm" && videoTrack.rotation !== 0) return false;

		if (!candidate.copyAudio) return true;

		const audioTracks = await input.getAudioTracks();
		if (audioTracks.length === 0) return true;
		if (audioTracks.length !== 1) return false;

		const audioTrack = audioTracks[0];
		const allowedAudioCodecs =
			format === "webm" ? WEBM_AUDIO_CODECS : MP4_AUDIO_CODECS;
		return (
			!!audioTrack?.codec &&
			allowedAudioCodecs.has(audioTrack.codec) &&
			(await audioTrack.getFirstTimestamp()) >= 0
		);
	}
}
