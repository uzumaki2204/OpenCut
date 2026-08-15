import { useState, useRef } from "react";
import { hasDragData } from "@/lib/drag-data";
import {
	getDroppedMediaFileSources,
	pickMediaFileSources,
	supportsMediaFilePicker,
} from "@/lib/media/file-source";
import { MEDIA_TEXT } from "@/lib/media/language";
import type { MediaFileSource } from "@/lib/media/types";

interface UseFileUploadOptions {
	accept?: string;
	multiple?: boolean;
	onFilesSelected?: (files: MediaFileSource[]) => void;
}

function containsFiles(dataTransfer: DataTransfer): boolean {
	return !hasDragData({ dataTransfer }) && dataTransfer.types.includes("Files");
}

export function useFileUpload({
	accept,
	multiple,
	onFilesSelected,
}: UseFileUploadOptions = {}) {
	const [isDragOver, setIsDragOver] = useState(false);
	const dragCounterRef = useRef(0);
	const inputRef = useRef<HTMLInputElement>(null);

	async function openFilePicker() {
		if (supportsMediaFilePicker()) {
			try {
				const sources = await pickMediaFileSources({
					multiple: multiple ?? false,
				});
				if (sources.length > 0) onFilesSelected?.(sources);
				return;
			} catch (error) {
				if (error instanceof DOMException && error.name === "AbortError")
					return;
				console.warn(MEDIA_TEXT.diagnostics.filePickerFallback, error);
			}
		}

		if (!inputRef.current) return;

		inputRef.current.accept = accept || "*";
		inputRef.current.multiple = multiple || false;
		inputRef.current.click();
	}

	function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
		const files = Array.from(event.target.files ?? []);
		if (files.length > 0 && onFilesSelected) {
			onFilesSelected(files.map((file) => ({ file })));
		}

		if (event.target) {
			event.target.value = "";
		}
	}

	function handleDragEnter(e: React.DragEvent) {
		e.preventDefault();

		if (!containsFiles(e.dataTransfer)) return;

		dragCounterRef.current += 1;
		setIsDragOver(true);
	}

	function handleDragOver(e: React.DragEvent) {
		e.preventDefault();

		if (!containsFiles(e.dataTransfer)) return;
	}

	function handleDragLeave(e: React.DragEvent) {
		e.preventDefault();

		if (!containsFiles(e.dataTransfer)) return;

		dragCounterRef.current -= 1;
		if (dragCounterRef.current === 0) {
			setIsDragOver(false);
		}
	}

	async function handleDrop(e: React.DragEvent) {
		e.preventDefault();
		setIsDragOver(false);
		dragCounterRef.current = 0;

		if (onFilesSelected && containsFiles(e.dataTransfer)) {
			const sources = await getDroppedMediaFileSources({
				dataTransfer: e.dataTransfer,
			});
			const shouldUseMultiple = multiple ?? false;

			if (shouldUseMultiple) {
				onFilesSelected(sources);
			} else if (sources.length > 0) {
				onFilesSelected([sources[0]]);
			}
		}
	}

	return {
		isDragOver,
		openFilePicker,
		fileInputProps: {
			ref: inputRef,
			type: "file",
			style: { display: "none" },
			onChange: handleFileChange,
		},
		dragProps: {
			onDragEnter: handleDragEnter,
			onDragOver: handleDragOver,
			onDragLeave: handleDragLeave,
			onDrop: handleDrop,
		},
	};
}
