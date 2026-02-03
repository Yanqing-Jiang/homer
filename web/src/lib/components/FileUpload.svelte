<script lang="ts">
	import * as api from '$lib/api/client';
	import { toast } from '$lib/stores/toasts.svelte';

	interface Props {
		sessionId: string | null;
		onFilesChange?: (files: api.Upload[]) => void;
	}

	let { sessionId, onFilesChange }: Props = $props();

	let attachedFiles = $state<api.Upload[]>([]);
	let isDragging = $state(false);
	let uploading = $state(false);
	let uploadError = $state<string | null>(null);
	let fileInput: HTMLInputElement;

	// Expose attached files to parent
	export function getAttachedFiles(): api.Upload[] {
		return attachedFiles;
	}

	export function clearFiles(): void {
		attachedFiles = [];
		onFilesChange?.(attachedFiles);
	}

	// Queue for sequential file uploads to prevent interleaving
	let uploadQueue = $state<File[]>([]);
	let isProcessingQueue = $state(false);

	async function processUploadQueue() {
		if (isProcessingQueue || uploadQueue.length === 0 || !sessionId) return;

		isProcessingQueue = true;
		uploading = true;
		uploadError = null;

		try {
			while (uploadQueue.length > 0) {
				const file = uploadQueue.shift()!;
				const result = await api.uploadFile(file, sessionId);
				attachedFiles = [...attachedFiles, result];
				onFilesChange?.(attachedFiles);
			}
		} catch (e) {
			uploadError = e instanceof Error ? e.message : 'Upload failed';
			// Clear remaining queue on error
			uploadQueue = [];
		} finally {
			isProcessingQueue = false;
			uploading = false;
		}
	}

	async function handleFiles(files: FileList | null) {
		if (!files || files.length === 0 || !sessionId) return;

		// Add to queue and process
		uploadQueue = [...uploadQueue, ...Array.from(files)];
		processUploadQueue();
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
		handleFiles(e.dataTransfer?.files || null);
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		isDragging = true;
	}

	function handleDragLeave(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
	}

	function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		handleFiles(input.files);
		input.value = ''; // Reset so same file can be selected again
	}

	async function removeFile(file: api.Upload) {
		if (!sessionId) return;

		try {
			await api.deleteUpload(sessionId, file.id);
			attachedFiles = attachedFiles.filter(f => f.id !== file.id);
			onFilesChange?.(attachedFiles);
		} catch (e) {
			console.error('Failed to remove file:', e);
			toast.error(`Failed to remove file: ${e instanceof Error ? e.message : 'Unknown error'}`);
		}
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}

	function getFileIcon(mimeType: string): string {
		if (mimeType.startsWith('image/')) return '🖼️';
		if (mimeType === 'application/pdf') return '📄';
		if (mimeType.startsWith('text/') || mimeType === 'application/json') return '📝';
		return '📎';
	}
</script>

<div class="file-upload">
	<!-- Attached files display -->
	{#if attachedFiles.length > 0}
		<div class="attached-files">
			{#each attachedFiles as file}
				<div class="attached-file">
					<span class="file-icon">{getFileIcon(file.mimeType)}</span>
					<span class="file-name" title={file.filename}>{file.filename}</span>
					<span class="file-size">{formatFileSize(file.size)}</span>
					<button class="remove-btn" onclick={() => removeFile(file)} title="Remove">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
							<path d="M18 6L6 18M6 6l12 12"/>
						</svg>
					</button>
				</div>
			{/each}
		</div>
	{/if}

	<!-- Error message -->
	{#if uploadError}
		<div class="upload-error">
			{uploadError}
			<button onclick={() => uploadError = null}>Dismiss</button>
		</div>
	{/if}

	<!-- Upload button and drop zone indicator -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="upload-controls"
		class:dragging={isDragging}
		ondrop={handleDrop}
		ondragover={handleDragOver}
		ondragleave={handleDragLeave}
	>
		<input
			type="file"
			multiple
			bind:this={fileInput}
			onchange={handleFileSelect}
			class="file-input"
			accept=".txt,.md,.csv,.html,.css,.js,.ts,.json,.xml,.png,.jpg,.jpeg,.gif,.webp,.svg,.pdf"
		/>

		<button
			class="attach-btn"
			onclick={() => fileInput.click()}
			disabled={uploading || !sessionId}
			title={sessionId ? 'Attach files' : 'Start a chat to attach files'}
		>
			{#if uploading}
				<span class="spinner"></span>
			{:else}
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
					<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
				</svg>
			{/if}
		</button>

		{#if isDragging}
			<div class="drop-overlay">
				Drop files here
			</div>
		{/if}
	</div>
</div>

<style>
	.file-upload {
		display: flex;
		align-items: flex-end;
		gap: 8px;
	}

	.attached-files {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		flex: 1;
	}

	.attached-file {
		display: flex;
		align-items: center;
		gap: 6px;
		background: #f0f0f0;
		padding: 4px 8px;
		border-radius: 4px;
		font-size: 12px;
	}

	.file-icon {
		font-size: 14px;
	}

	.file-name {
		max-width: 120px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-size {
		color: #666;
	}

	.remove-btn {
		background: none;
		border: none;
		padding: 2px;
		cursor: pointer;
		color: #666;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 2px;
	}

	.remove-btn:hover {
		background: #ddd;
		color: #333;
	}

	.upload-error {
		background: #fef2f2;
		color: #b91c1c;
		padding: 6px 10px;
		border-radius: 4px;
		font-size: 12px;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.upload-error button {
		background: none;
		border: none;
		color: #b91c1c;
		text-decoration: underline;
		cursor: pointer;
		font-size: 12px;
	}

	.upload-controls {
		position: relative;
	}

	.upload-controls.dragging {
		outline: 2px dashed #6264a7;
		outline-offset: 2px;
		border-radius: 4px;
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

	.drop-overlay {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		background: rgba(98, 100, 167, 0.9);
		color: white;
		padding: 8px 16px;
		border-radius: 4px;
		font-size: 12px;
		white-space: nowrap;
		pointer-events: none;
	}
</style>
