import { describe, expect, test } from "bun:test";
import {
	clampVideoPreviewTime,
	getMediaPreviewSummary,
	NativeVideoFrameSource,
	type NativeVideoEnvironment,
} from "./video-preview";

class FakeVideo extends EventTarget {
	preload = "";
	muted = false;
	playsInline = false;
	src = "";
	readyState = 0;
	videoWidth = 1920;
	videoHeight = 1080;
	duration = 10;
	seekHistory: number[] = [];
	pauseCount = 0;
	private mediaTime = 0;

	get currentTime(): number {
		return this.mediaTime;
	}

	set currentTime(value: number) {
		this.mediaTime = value;
		this.seekHistory.push(value);
		queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
	}

	load(): void {
		if (!this.src) return;
		queueMicrotask(() => {
			this.readyState = 1;
			this.dispatchEvent(new Event("loadedmetadata"));
			queueMicrotask(() => {
				this.readyState = 2;
				this.dispatchEvent(new Event("loadeddata"));
			});
		});
	}

	pause(): void {
		this.pauseCount += 1;
	}

	removeAttribute(name: string): void {
		if (name === "src") this.src = "";
	}
}

class FakeCanvas {
	width = 0;
	height = 0;
	drawCount = 0;

	getContext(type: string) {
		if (type !== "2d") return null;
		return {
			drawImage: () => {
				this.drawCount += 1;
			},
		};
	}
}

function createEnvironment({
	video,
	canvases,
	revokedUrls,
}: {
	video: FakeVideo;
	canvases: FakeCanvas[];
	revokedUrls: string[];
}): NativeVideoEnvironment {
	return {
		createVideo: () => video as unknown as HTMLVideoElement,
		createCanvas: () => {
			const canvas = new FakeCanvas();
			canvases.push(canvas);
			return canvas as unknown as HTMLCanvasElement;
		},
		createObjectUrl: () => "blob:test-video",
		revokeObjectUrl: (url) => revokedUrls.push(url),
	};
}

describe("native video preview", () => {
	test("clamps timestamps to the last decodable frame", () => {
		expect(
			clampVideoPreviewTime({ time: -1, duration: 10, frameDuration: 0.1 }),
		).toBe(0);
		expect(
			clampVideoPreviewTime({ time: 15, duration: 10, frameDuration: 0.1 }),
		).toBe(9.95);
	});

	test("serializes seeks and releases native resources", async () => {
		const video = new FakeVideo();
		const canvases: FakeCanvas[] = [];
		const revokedUrls: string[] = [];
		const source = await NativeVideoFrameSource.create({
			file: {} as File,
			fps: 10,
			environment: createEnvironment({ video, canvases, revokedUrls }),
		});

		const [first, second] = await Promise.all([
			source.getFrame({ time: 1 }),
			source.getFrame({ time: 2 }),
		]);

		expect(first.timestamp).toBe(1);
		expect(second.timestamp).toBe(2);
		expect(video.seekHistory).toEqual([1, 2]);
		expect(new Set([first.canvas, second.canvas]).size).toBe(2);
		expect(canvases.reduce((sum, canvas) => sum + canvas.drawCount, 0)).toBe(2);
		expect(first.canvas.width).toBe(1920);
		expect(first.canvas.height).toBe(1080);

		source.dispose();
		expect(video.pauseCount).toBe(1);
		expect(revokedUrls).toEqual(["blob:test-video"]);
	});

	test("times out and revokes the object URL when metadata never loads", async () => {
		const video = new FakeVideo();
		video.load = () => {};
		const revokedUrls: string[] = [];

		await expect(
			NativeVideoFrameSource.create({
				file: {} as File,
				timeoutMs: 1,
				environment: createEnvironment({
					video,
					canvases: [],
					revokedUrls,
				}),
			}),
		).rejects.toThrow();
		expect(revokedUrls).toEqual(["blob:test-video"]);
	});
});

describe("media preview summary", () => {
	test("counts native and unavailable assets", () => {
		expect(
			getMediaPreviewSummary({
				assets: [
					{ previewMode: "webcodecs" },
					{ previewMode: "native" },
					{ previewMode: "unavailable" },
					{},
				],
			}),
		).toEqual({ nativePreviewCount: 1, unavailablePreviewCount: 1 });
	});
});
