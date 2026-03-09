<script lang="ts">
	import * as api from '$lib/api/client';

	export interface DisplayFile {
		localId: string;
		filename: string;
		mimeType: string;
		size: number;
		status: 'uploading' | 'done' | 'error';
		previewUrl: string | null;
		path: string | null;
		sessionId: string | null;
		createdAt?: string;
		uploadId?: string;
		error?: string;
	}

	interface Props {
		sessionId: string | null;
		ensureSessionForAttachments?: () => Promise<string | null>;
		onFilesChange?: (files: api.Upload[]) => void;
		onDisplayChange?: (files: DisplayFile[]) => void;
	}

	let { sessionId, ensureSessionForAttachments, onFilesChange, onDisplayChange }: Props = $props();

	let displayFiles = $state<DisplayFile[]>([]);
	let uploading = $state(false);
	let fileInput: HTMLInputElement;

	// Track removed localIds so in-flight uploads don't fire callbacks
	let removedIds = new Set<string>();

	function notifyDisplay() {
		onDisplayChange?.([...displayFiles]);
	}

	function getCompletedUploads(): api.Upload[] {
		return displayFiles
			.filter((f) => f.status === 'done' && f.uploadId && f.path)
			.map(f => ({
				id: f.uploadId!,
				filename: f.filename,
				path: f.path!,
				mimeType: f.mimeType,
				size: f.size,
				sessionId: f.sessionId || sessionId || '',
				createdAt: f.createdAt || new Date().toISOString()
			}));
	}

	export function clearFiles(): void {
		for (const f of displayFiles) {
			if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
		}
		displayFiles = [];
		removedIds.clear();
		notifyDisplay();
		onFilesChange?.([]);
	}

	export async function addFiles(files: FileList | File[]): Promise<void> {
		await handleFiles(files);
	}

	export function removeFile(localId: string): void {
		const file = displayFiles.find(f => f.localId === localId);
		if (!file) return;

		if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);

		// If uploaded, delete from server
		if (file.uploadId && file.sessionId) {
			api.deleteUpload(file.sessionId, file.uploadId).catch(console.error);
		}

		// Mark as removed so in-flight upload skips callbacks
		removedIds.add(localId);

		displayFiles = displayFiles.filter(f => f.localId !== localId);
		notifyDisplay();
		onFilesChange?.(getCompletedUploads());
	}

	// Queue for sequential file uploads
	let uploadQueue = $state<Array<{ file: File; localId: string; sessionId: string }>>([]);
	let isProcessingQueue = $state(false);

	async function processUploadQueue() {
		if (isProcessingQueue || uploadQueue.length === 0) return;

		isProcessingQueue = true;
		uploading = true;

		try {
			while (uploadQueue.length > 0) {
				const item = uploadQueue.shift()!;

				// Skip if removed while queued
				if (removedIds.has(item.localId)) continue;

				try {
					const result = await api.uploadFile(item.file, item.sessionId);

					// Skip callbacks if removed during upload
					if (removedIds.has(item.localId)) continue;

					// Update display file to done
					displayFiles = displayFiles.map(f =>
						f.localId === item.localId
							? {
								...f,
								status: 'done' as const,
								uploadId: result.id,
								path: result.path,
								sessionId: result.sessionId,
								createdAt: result.createdAt
							}
							: f
					);
					notifyDisplay();
					onFilesChange?.(getCompletedUploads());
				} catch (e) {
					if (removedIds.has(item.localId)) continue;

					displayFiles = displayFiles.map(f =>
						f.localId === item.localId
							? { ...f, status: 'error' as const, error: e instanceof Error ? e.message : 'Upload failed' }
							: f
					);
					notifyDisplay();
				}
			}
		} finally {
			isProcessingQueue = false;
			uploading = false;
		}
	}

	async function handleFiles(files: FileList | File[] | null) {
		if (!files || files.length === 0) return;

		const resolvedSessionId = sessionId || await ensureSessionForAttachments?.();
		if (!resolvedSessionId) return;

		const fileArray = Array.from(files);

		// Create DisplayFile entries immediately (optimistic)
		const newDisplayFiles: DisplayFile[] = fileArray.map(file => ({
			localId: crypto.randomUUID(),
			filename: file.name,
			mimeType: file.type,
			size: file.size,
			status: 'uploading' as const,
			previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
			path: null,
			sessionId: resolvedSessionId
		}));

		displayFiles = [...displayFiles, ...newDisplayFiles];
		notifyDisplay();

		// Queue for upload
		const queueItems = fileArray.map((file, i) => ({
			file,
			localId: newDisplayFiles[i].localId,
			sessionId: resolvedSessionId
		}));
		uploadQueue = [...uploadQueue, ...queueItems];
		await processUploadQueue();
	}

	async function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		await handleFiles(input.files);
		input.value = '';
	}
</script>

<div class="file-upload">
	<input
		type="file"
		multiple
		bind:this={fileInput}
		onchange={handleFileSelect}
		class="file-input"
	/>

	<button
		class="attach-btn"
		onclick={() => fileInput.click()}
		disabled={uploading}
		title="Attach files"
	>
		{#if uploading}
			<span class="spinner"></span>
		{:else}
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
				<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
			</svg>
		{/if}
	</button>
</div>

<style>
	.file-upload {
		display: flex;
		align-items: flex-end;
	}

	.file-input {
		display: none;
	}

	.attach-btn {
		width: 36px;
		height: 36px;
		border-radius: 4px;
		background: transparent;
		border: 1px solid #e0e0e0;
		color: #666;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s;
	}

	.attach-btn:hover:not(:disabled) {
		background: #f5f5f5;
		border-color: #6264a7;
		color: #6264a7;
	}

	.attach-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.spinner {
		width: 16px;
		height: 16px;
		border: 2px solid #e0e0e0;
		border-top-color: #6264a7;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>
