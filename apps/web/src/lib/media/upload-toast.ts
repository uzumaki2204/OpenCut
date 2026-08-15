import { toast } from "sonner";
import {
	getMediaFailureMessage,
	getMediaPreparingMessage,
	MEDIA_TEXT,
} from "./language";

export interface MediaUploadToastResult {
	uploadedCount: number;
	assetNames?: string[];
	handleLinkedCount?: number;
	sessionOnlyCount?: number;
}

function waitForNextPaint(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => resolve());
		});
	});
}

export async function showMediaUploadToast<T extends MediaUploadToastResult>({
	filesCount,
	promise,
}: {
	filesCount: number;
	promise: Promise<T> | (() => Promise<T>);
}) {
	const run = typeof promise === "function" ? promise : () => promise;
	const toastPromise = toast.promise(
		async () => {
			await waitForNextPaint();
			return run();
		},
		{
			loading: getMediaPreparingMessage({ count: filesCount }),
			success: ({
				uploadedCount,
				assetNames,
				handleLinkedCount = 0,
				sessionOnlyCount = 0,
			}) => {
				if (sessionOnlyCount > 0) {
					if (uploadedCount === 1) {
						const assetName = assetNames?.[0];
						return `${assetName ?? MEDIA_TEXT.assetSingular} ${MEDIA_TEXT.sessionReadySuffix}`;
					}
					return sessionOnlyCount === 1
						? MEDIA_TEXT.sessionSingleFallback
						: `${sessionOnlyCount} ${MEDIA_TEXT.sessionMultipleSuffix}`;
				}

				if (handleLinkedCount > 0 && handleLinkedCount === uploadedCount) {
					if (uploadedCount === 1) {
						const assetName = assetNames?.[0];
						return `${assetName ?? MEDIA_TEXT.assetSingular} ${MEDIA_TEXT.handleReadySuffix}`;
					}
					return `${handleLinkedCount} ${MEDIA_TEXT.handleMultipleSuffix}`;
				}

				if (uploadedCount === 1) {
					const assetName = assetNames?.[0];
					return assetName
						? `${assetName} ${MEDIA_TEXT.preparedNamedSuffix}`
						: MEDIA_TEXT.preparedSingleFallback;
				}

				if (uploadedCount > 1) {
					return `${uploadedCount} ${MEDIA_TEXT.preparedMultipleSuffix}`;
				}

				return MEDIA_TEXT.preparedNone;
			},
			error: getMediaFailureMessage({ count: filesCount }),
		},
	);

	return toastPromise.unwrap();
}
