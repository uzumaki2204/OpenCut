import { describe, expect, test } from "bun:test";
import {
	ALL_FORMATS,
	BlobSource,
	BufferTarget,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	Input,
	Output,
	WebMOutputFormat,
} from "mediabunny";
import type { DirectJoinExportCandidate } from "@/lib/export/strategy";
import type { MediaAsset } from "@/lib/media/types";
import type { VideoElement } from "@/lib/timeline";
import { DirectJoinExporter } from "./direct-join-exporter";

const TICKS_PER_SECOND = 1_000;

async function createVp8File({
	name,
	width = 640,
	height = 360,
}: {
	name: string;
	width?: number;
	height?: number;
}): Promise<File> {
	const target = new BufferTarget();
	const output = new Output({ format: new WebMOutputFormat(), target });
	const source = new EncodedVideoPacketSource("vp8");
	output.addVideoTrack(source);
	await output.start();

	const decoderConfig: VideoDecoderConfig = {
		codec: "vp8",
		codedWidth: width,
		codedHeight: height,
	};
	await source.add(new EncodedPacket(new Uint8Array([0]), "key", 0, 0.5), {
		decoderConfig,
	});
	await source.add(new EncodedPacket(new Uint8Array([1]), "delta", 0.5, 0.5), {
		decoderConfig,
	});
	source.close();
	await output.finalize();

	if (!target.buffer) throw new Error("Expected a WebM fixture buffer");
	return new File([target.buffer], name, { type: "video/webm" });
}

function createCandidate({
	files,
}: {
	files: File[];
}): DirectJoinExportCandidate {
	return {
		kind: "join",
		totalSourceBytes: files.reduce((total, file) => total + file.size, 0),
		clips: files.map((file, index) => {
			const mediaAsset: MediaAsset = {
				id: `media-${index}`,
				name: file.name,
				type: "video",
				file,
			};
			return {
				element: { id: `clip-${index}` } as VideoElement,
				mediaAsset,
				outputStartTicks: index * TICKS_PER_SECOND,
				trimStartTicks: 0,
				durationTicks: TICKS_PER_SECOND,
			};
		}),
	};
}

describe("DirectJoinExporter", () => {
	test("joins encoded packets and rewrites timestamps without encoding", async () => {
		const files = await Promise.all([
			createVp8File({ name: "first.webm" }),
			createVp8File({ name: "second.webm" }),
		]);
		const progress: number[] = [];
		const exporter = new DirectJoinExporter({
			candidate: createCandidate({ files }),
			format: "webm",
			destination: { kind: "buffer" },
			ticksPerSecond: TICKS_PER_SECOND,
		});
		exporter.on("progress", (value) => progress.push(value));

		const result = await exporter.export();

		expect(result?.kind).toBe("buffer");
		if (result?.kind !== "buffer") throw new Error("Expected joined buffer");
		const input = new Input({
			source: new BlobSource(new Blob([result.buffer])),
			formats: ALL_FORMATS,
		});
		const videoTracks = await input.getVideoTracks();
		expect(videoTracks).toHaveLength(1);
		const track = videoTracks[0];
		if (!track) throw new Error("Expected joined video track");
		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			timestamps.push(packet.timestamp);
		}
		input.dispose();

		expect(timestamps).toEqual([0, 0.5, 1, 1.5]);
		expect(progress.at(-1)).toBe(1);
	});

	test("rejects different video configurations before writing output", async () => {
		const files = await Promise.all([
			createVp8File({ name: "first.webm" }),
			createVp8File({ name: "second.webm", width: 1280, height: 720 }),
		]);
		const exporter = new DirectJoinExporter({
			candidate: createCandidate({ files }),
			format: "webm",
			destination: { kind: "buffer" },
			ticksPerSecond: TICKS_PER_SECOND,
		});

		expect(await exporter.export()).toEqual({
			kind: "unavailable",
			reason: "incompatibleVideo",
		});
	});

	test("snaps a mid-GOP trim to the previous keyframe and preserves timeline timestamps", async () => {
		const file = await createVp8File({ name: "shared.webm" });
		const candidate = createCandidate({ files: [file, file] });
		const sharedMediaAsset = candidate.clips[0]?.mediaAsset;
		if (!sharedMediaAsset) throw new Error("Expected a shared media asset");
		const firstClip = candidate.clips[0];
		const secondClip = candidate.clips[1];
		if (!firstClip || !secondClip) throw new Error("Expected two clips");
		firstClip.trimStartTicks = 500;
		firstClip.durationTicks = 500;
		secondClip.mediaAsset = sharedMediaAsset;
		secondClip.outputStartTicks = 500;
		secondClip.durationTicks = 500;

		const exporter = new DirectJoinExporter({
			candidate,
			format: "webm",
			destination: { kind: "buffer" },
			ticksPerSecond: TICKS_PER_SECOND,
		});
		const result = await exporter.export();

		expect(result?.kind).toBe("buffer");
		if (result?.kind !== "buffer") throw new Error("Expected joined buffer");
		expect(result.warnings).toEqual([
			{
				code: "direct-join-keyframe-snap",
				clipId: "clip-0",
				snapDeltaTicks: 500,
				ticksPerSecond: TICKS_PER_SECOND,
			},
		]);

		const input = new Input({
			source: new BlobSource(new Blob([result.buffer])),
			formats: ALL_FORMATS,
		});
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) throw new Error("Expected joined video track");
		const timestamps: number[] = [];
		for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
			timestamps.push(packet.timestamp);
		}
		input.dispose();

		expect(timestamps).toEqual([0, 0.5]);
	});
});
