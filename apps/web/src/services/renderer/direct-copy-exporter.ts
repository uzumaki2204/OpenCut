import EventEmitter from "eventemitter3";
import type { StreamTargetChunk } from "mediabunny";
import type { ExportDestination } from "@/lib/export";
import type { DirectCopyExportCandidate } from "@/lib/export/strategy";
import type { ExportOutputResult } from "./export-output";

const DEFAULT_CHUNK_SIZE = 32 * 1024 * 1024;

type DirectCopyExporterEvents = {
	progress: [progress: number];
};

export class DirectCopyExporter extends EventEmitter<DirectCopyExporterEvents> {
	private isCancelled = false;

	constructor(
		private params: {
			candidate: DirectCopyExportCandidate;
			destination: ExportDestination;
			chunkSize?: number;
		},
	) {
		super();
	}

	cancel(): void {
		this.isCancelled = true;
	}

	async export(): Promise<ExportOutputResult | null> {
		const { candidate, destination } = this.params;
		const file = candidate.mediaAsset.file;

		if (destination.kind === "buffer") {
			const buffer = await file.arrayBuffer();
			if (this.isCancelled) return null;
			this.emit("progress", 1);
			return { kind: "buffer", buffer };
		}

		const writer = destination.writable.getWriter();
		const chunkSize = this.params.chunkSize ?? DEFAULT_CHUNK_SIZE;

		try {
			if (file.size === 0) {
				this.emit("progress", 1);
				return { kind: "saved" };
			}

			for (let position = 0; position < file.size; position += chunkSize) {
				if (this.isCancelled) return null;
				const end = Math.min(position + chunkSize, file.size);
				const data = new Uint8Array(
					await file.slice(position, end).arrayBuffer(),
				);
				if (this.isCancelled) return null;

				const chunk: StreamTargetChunk = { type: "write", data, position };
				await writer.write(chunk);
				this.emit("progress", end / file.size);
			}

			return { kind: "saved" };
		} catch (error) {
			if (this.isCancelled) return null;
			throw error;
		} finally {
			writer.releaseLock();
		}
	}
}
