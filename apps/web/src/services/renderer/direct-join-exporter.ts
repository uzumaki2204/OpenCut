import EventEmitter from "eventemitter3";
import {
	ALL_FORMATS,
	BlobSource,
	EncodedAudioPacketSource,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	Input,
	Output,
} from "mediabunny";
import type {
	AudioCodec,
	EncodedPacket,
	InputAudioTrack,
	InputVideoTrack,
	VideoCodec,
} from "mediabunny";
import type { ExportDestination, ExportFormat } from "@/lib/export";
import type {
	DirectJoinExportCandidate,
	DirectJoinExportClip,
} from "@/lib/export/strategy";
import {
	createExportOutputFormat,
	createExportOutputTarget,
	getExportOutputResult,
	type ExportOutputResult,
} from "./export-output";

const MP4_VIDEO_CODECS = new Set<VideoCodec>(["avc"]);
const MP4_AUDIO_CODECS = new Set<AudioCodec>(["aac"]);
const WEBM_VIDEO_CODECS = new Set<VideoCodec>(["vp8", "vp9", "av1"]);
const WEBM_AUDIO_CODECS = new Set<AudioCodec>(["opus", "vorbis"]);

export type DirectJoinUnavailableReason =
	| "unsupportedCodec"
	| "incompatibleVideo"
	| "incompatibleAudio"
	| "trimNotKeyframe"
	| "invalidSource"
	| "writeFailed";

export type DirectJoinExporterResult =
	| ExportOutputResult
	| { kind: "unavailable"; reason: DirectJoinUnavailableReason };

type DirectJoinExporterEvents = {
	progress: [progress: number];
};

interface PreparedClip {
	clip: DirectJoinExportClip;
	input: Input;
	videoTrack: InputVideoTrack;
	audioTrack: InputAudioTrack | null;
	videoConfig: VideoDecoderConfig;
	audioConfig: AudioDecoderConfig | null;
	videoAnchorSeconds: number;
}

type PreparedResult =
	| { success: true; clips: PreparedClip[] }
	| { success: false; reason: DirectJoinUnavailableReason };

interface PacketCursor {
	kind: "video" | "audio";
	iterator: AsyncGenerator<EncodedPacket, void, unknown>;
	result: IteratorYieldResult<EncodedPacket>;
}

function descriptionsMatch({
	left,
	right,
}: {
	left?: AllowSharedBufferSource;
	right?: AllowSharedBufferSource;
}): boolean {
	if (!left || !right) return left === right;
	const leftBytes = ArrayBuffer.isView(left)
		? new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
		: new Uint8Array(left);
	const rightBytes = ArrayBuffer.isView(right)
		? new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
		: new Uint8Array(right);
	if (leftBytes.length !== rightBytes.length) return false;
	return leftBytes.every((value, index) => value === rightBytes[index]);
}

function videoTracksMatch({
	left,
	right,
}: {
	left: PreparedClip;
	right: PreparedClip;
}): boolean {
	return (
		left.videoTrack.codec === right.videoTrack.codec &&
		left.videoTrack.codedWidth === right.videoTrack.codedWidth &&
		left.videoTrack.codedHeight === right.videoTrack.codedHeight &&
		left.videoTrack.rotation === right.videoTrack.rotation &&
		left.videoConfig.codec === right.videoConfig.codec &&
		descriptionsMatch({
			left: left.videoConfig.description,
			right: right.videoConfig.description,
		})
	);
}

function audioTracksMatch({
	left,
	right,
}: {
	left: PreparedClip;
	right: PreparedClip;
}): boolean {
	if (!left.audioTrack || !left.audioConfig) {
		return !right.audioTrack && !right.audioConfig;
	}
	if (!right.audioTrack || !right.audioConfig) return false;
	return (
		left.audioTrack.codec === right.audioTrack.codec &&
		left.audioTrack.numberOfChannels === right.audioTrack.numberOfChannels &&
		left.audioTrack.sampleRate === right.audioTrack.sampleRate &&
		left.audioConfig.codec === right.audioConfig.codec &&
		descriptionsMatch({
			left: left.audioConfig.description,
			right: right.audioConfig.description,
		})
	);
}

export class DirectJoinExporter extends EventEmitter<DirectJoinExporterEvents> {
	private isCancelled = false;
	private output: Output | null = null;
	private inputs: Input[] = [];
	private lastProgress = 0;
	private readonly totalDurationTicks: number;

	constructor(
		private params: {
			candidate: DirectJoinExportCandidate;
			format: ExportFormat;
			destination: ExportDestination;
			ticksPerSecond: number;
		},
	) {
		super();
		this.totalDurationTicks = params.candidate.clips.reduce(
			(total, clip) => total + clip.durationTicks,
			0,
		);
	}

	cancel(): void {
		this.isCancelled = true;
		void this.output?.cancel();
	}

	async export(): Promise<DirectJoinExporterResult | null> {
		try {
			const prepared = await this.prepareClips();
			if (!prepared.success) {
				return { kind: "unavailable", reason: prepared.reason };
			}
			if (this.isCancelled) return null;

			const firstClip = prepared.clips[0];
			if (!firstClip?.videoTrack.codec) {
				return { kind: "unavailable", reason: "invalidSource" };
			}

			const target = createExportOutputTarget({
				destination: this.params.destination,
			});
			const output = new Output({
				format: createExportOutputFormat({
					format: this.params.format,
					destination: this.params.destination,
				}),
				target,
			});
			this.output = output;

			const videoSource = new EncodedVideoPacketSource(
				firstClip.videoTrack.codec,
			);
			output.addVideoTrack(videoSource, {
				rotation: firstClip.videoTrack.rotation,
			});

			const firstAudioClip = prepared.clips.find(
				(clip) => clip.audioTrack?.codec,
			);
			const audioSource = firstAudioClip?.audioTrack?.codec
				? new EncodedAudioPacketSource(firstAudioClip.audioTrack.codec)
				: null;
			if (audioSource) output.addAudioTrack(audioSource);

			await output.start();
			for (const preparedClip of prepared.clips) {
				if (this.isCancelled) return null;
				await this.writeClip({
					preparedClip,
					videoSource,
					audioSource,
				});
			}

			videoSource.close();
			audioSource?.close();
			await output.finalize();
			this.reportProgress({ progress: 1 });
			return getExportOutputResult({ target });
		} catch {
			await this.output?.cancel();
			if (this.isCancelled) return null;
			return { kind: "unavailable", reason: "writeFailed" };
		} finally {
			this.output = null;
			for (const input of this.inputs) input.dispose();
			this.inputs = [];
		}
	}

	private async prepareClips(): Promise<PreparedResult> {
		const preparedClips: PreparedClip[] = [];

		try {
			for (const clip of this.params.candidate.clips) {
				if (this.isCancelled) {
					return { success: false, reason: "invalidSource" };
				}
				const input = new Input({
					source: new BlobSource(clip.mediaAsset.file),
					formats: ALL_FORMATS,
				});
				this.inputs.push(input);

				const videoTracks = await input.getVideoTracks();
				const audioTracks = await input.getAudioTracks();
				if (videoTracks.length !== 1 || audioTracks.length > 1) {
					return { success: false, reason: "invalidSource" };
				}

				const videoTrack = videoTracks[0];
				if (
					!videoTrack?.codec ||
					!(await this.isVideoTrackSupported(videoTrack))
				) {
					return { success: false, reason: "unsupportedCodec" };
				}
				const videoConfig = await videoTrack.getDecoderConfig();
				if (!videoConfig) {
					return { success: false, reason: "invalidSource" };
				}

				const audioTrack = audioTracks[0] ?? null;
				if (
					audioTrack?.codec &&
					!this.isAudioCodecSupported(audioTrack.codec)
				) {
					return { success: false, reason: "unsupportedCodec" };
				}
				const audioConfig = audioTrack
					? await audioTrack.getDecoderConfig()
					: null;
				if (audioTrack && (!audioTrack.codec || !audioConfig)) {
					return { success: false, reason: "invalidSource" };
				}

				const videoAnchorSeconds = await this.getVideoAnchorSeconds({
					clip,
					videoTrack,
				});
				if (videoAnchorSeconds === null) {
					return { success: false, reason: "trimNotKeyframe" };
				}

				preparedClips.push({
					clip,
					input,
					videoTrack,
					audioTrack,
					videoConfig,
					audioConfig,
					videoAnchorSeconds,
				});
			}
		} catch {
			return { success: false, reason: "invalidSource" };
		}

		const firstClip = preparedClips[0];
		if (!firstClip) return { success: false, reason: "invalidSource" };
		if (
			preparedClips.some(
				(preparedClip) =>
					!videoTracksMatch({ left: firstClip, right: preparedClip }),
			)
		) {
			return { success: false, reason: "incompatibleVideo" };
		}

		const clipsWithAudio = preparedClips.filter(
			(preparedClip) => preparedClip.audioTrack && preparedClip.audioConfig,
		);
		const firstAudioClip = clipsWithAudio[0];
		if (
			firstAudioClip &&
			clipsWithAudio.some(
				(preparedClip) =>
					!audioTracksMatch({ left: firstAudioClip, right: preparedClip }),
			)
		) {
			return { success: false, reason: "incompatibleAudio" };
		}

		return { success: true, clips: preparedClips };
	}

	private async isVideoTrackSupported(
		videoTrack: InputVideoTrack,
	): Promise<boolean> {
		if (!videoTrack.codec || (await videoTrack.canBeTransparent()))
			return false;
		const allowedCodecs =
			this.params.format === "webm" ? WEBM_VIDEO_CODECS : MP4_VIDEO_CODECS;
		return (
			allowedCodecs.has(videoTrack.codec) &&
			(this.params.format !== "webm" || videoTrack.rotation === 0)
		);
	}

	private isAudioCodecSupported(codec: AudioCodec): boolean {
		const allowedCodecs =
			this.params.format === "webm" ? WEBM_AUDIO_CODECS : MP4_AUDIO_CODECS;
		return allowedCodecs.has(codec);
	}

	private async getVideoAnchorSeconds({
		clip,
		videoTrack,
	}: {
		clip: DirectJoinExportClip;
		videoTrack: InputVideoTrack;
	}): Promise<number | null> {
		const trimStartSeconds = clip.trimStartTicks / this.params.ticksPerSecond;
		const sink = new EncodedPacketSink(videoTrack);
		const startPacket =
			trimStartSeconds === 0
				? await sink.getFirstPacket({ verifyKeyPackets: true })
				: await sink.getKeyPacket(trimStartSeconds, {
						verifyKeyPackets: true,
					});
		if (!startPacket || startPacket.type !== "key") return null;
		if (trimStartSeconds === 0) return startPacket.timestamp;

		const tolerance = 1 / videoTrack.timeResolution + Number.EPSILON;
		return Math.abs(startPacket.timestamp - trimStartSeconds) <= tolerance
			? startPacket.timestamp
			: null;
	}

	private async writeClip({
		preparedClip,
		videoSource,
		audioSource,
	}: {
		preparedClip: PreparedClip;
		videoSource: EncodedVideoPacketSource;
		audioSource: EncodedAudioPacketSource | null;
	}): Promise<void> {
		const videoCursor = await this.createVideoCursor({ preparedClip });
		const audioCursor =
			audioSource && preparedClip.audioTrack && preparedClip.audioConfig
				? await this.createAudioCursor({ preparedClip })
				: null;
		let video = videoCursor;
		let audio = audioCursor;

		while (video || audio) {
			if (this.isCancelled) return;
			const cursor =
				!audio ||
				(video && video.result.value.timestamp <= audio.result.value.timestamp)
					? video
					: audio;
			if (!cursor) break;

			const packet = cursor.result.value;
			const mappedPacket = packet.clone({
				timestamp:
					this.getClipOutputStartSeconds(preparedClip.clip) +
					packet.timestamp -
					preparedClip.videoAnchorSeconds,
			});
			if (cursor.kind === "video") {
				await videoSource.add(mappedPacket, {
					decoderConfig: preparedClip.videoConfig,
				});
			} else if (audioSource && preparedClip.audioConfig) {
				await audioSource.add(mappedPacket, {
					decoderConfig: preparedClip.audioConfig,
				});
			}

			this.reportPacketProgress({ preparedClip, packet });
			const nextResult = await cursor.iterator.next();
			if (nextResult.done) {
				if (cursor.kind === "video") video = null;
				else audio = null;
			} else {
				cursor.result = nextResult;
			}
		}
	}

	private async createVideoCursor({
		preparedClip,
	}: {
		preparedClip: PreparedClip;
	}): Promise<PacketCursor | null> {
		const sink = new EncodedPacketSink(preparedClip.videoTrack);
		const startPacket = await sink.getKeyPacket(
			preparedClip.videoAnchorSeconds,
			{ verifyKeyPackets: true },
		);
		if (!startPacket) return null;
		const endPacket = await this.getEndPacket({
			sink,
			preparedClip,
		});
		const iterator = sink.packets(startPacket, endPacket, {
			verifyKeyPackets: true,
		});
		const result = await iterator.next();
		return result.done ? null : { kind: "video", iterator, result };
	}

	private async createAudioCursor({
		preparedClip,
	}: {
		preparedClip: PreparedClip;
	}): Promise<PacketCursor | null> {
		const audioTrack = preparedClip.audioTrack;
		if (!audioTrack) return null;
		const sink = new EncodedPacketSink(audioTrack);
		let startPacket = await sink.getPacket(preparedClip.videoAnchorSeconds);
		if (!startPacket) startPacket = await sink.getFirstPacket();
		if (
			startPacket &&
			startPacket.timestamp < preparedClip.videoAnchorSeconds
		) {
			startPacket = await sink.getNextPacket(startPacket);
		}
		if (!startPacket) return null;

		const endPacket = await this.getEndPacket({
			sink,
			preparedClip,
		});
		const iterator = sink.packets(startPacket, endPacket);
		const result = await iterator.next();
		return result.done ? null : { kind: "audio", iterator, result };
	}

	private async getEndPacket({
		sink,
		preparedClip,
	}: {
		sink: EncodedPacketSink;
		preparedClip: PreparedClip;
	}): Promise<EncodedPacket | undefined> {
		const endSeconds =
			preparedClip.clip.trimStartTicks / this.params.ticksPerSecond +
			preparedClip.clip.durationTicks / this.params.ticksPerSecond;
		const packetAtEnd = await sink.getPacket(endSeconds, {
			metadataOnly: true,
		});
		if (!packetAtEnd) return undefined;
		if (packetAtEnd.timestamp >= endSeconds) return packetAtEnd;
		return (
			(await sink.getNextPacket(packetAtEnd, { metadataOnly: true })) ??
			undefined
		);
	}

	private reportPacketProgress({
		preparedClip,
		packet,
	}: {
		preparedClip: PreparedClip;
		packet: EncodedPacket;
	}): void {
		const localSeconds = Math.max(
			0,
			packet.timestamp - preparedClip.videoAnchorSeconds,
		);
		const progressTicks =
			preparedClip.clip.outputStartTicks +
			Math.min(
				preparedClip.clip.durationTicks,
				localSeconds * this.params.ticksPerSecond,
			);
		this.reportProgress({
			progress: Math.min(progressTicks / this.totalDurationTicks, 0.999),
		});
	}

	private reportProgress({ progress }: { progress: number }): void {
		if (progress <= this.lastProgress && progress !== 1) return;
		this.lastProgress = progress;
		this.emit("progress", progress);
	}

	private getClipOutputStartSeconds(clip: DirectJoinExportClip): number {
		return clip.outputStartTicks / this.params.ticksPerSecond;
	}
}
