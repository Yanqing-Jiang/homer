<script lang="ts">
	import type { CommandDefinition, Upload } from '$lib/api/client';
	import { transcribeAudio } from '$lib/api/client';
	import { toast } from '$lib/stores/toasts.svelte';
	import FileUpload, { type DisplayFile } from './FileUpload.svelte';

	let {
		value = $bindable(''),
		isStreaming,
		sessionId,
		ensureSessionForAttachments,
		attachedFiles = $bindable<Upload[]>([]),
		showSlashCommands = $bindable(false),
		filteredCommands,
		selectedCommandIndex = $bindable(0),
		onSend,
		onSelectCommand,
		onInputChange
	}: {
		value: string;
		isStreaming: boolean;
		sessionId: string | null;
		ensureSessionForAttachments: () => Promise<string | null>;
		attachedFiles: Upload[];
		showSlashCommands: boolean;
		filteredCommands: CommandDefinition[];
		selectedCommandIndex: number;
		onSend: () => void;
		onSelectCommand: (cmd: CommandDefinition) => void;
		onInputChange: (e: Event) => void;
	} = $props();

	let fileUploadComponent: FileUpload;
	let chatInputElement: HTMLTextAreaElement;
	let displayFiles = $state<DisplayFile[]>([]);
	const hasUploadingFiles = $derived(displayFiles.some((file) => file.status === 'uploading'));
	const uploadedDisplayFiles = $derived(
		displayFiles.filter((file) => file.status === 'done' && file.path)
	);

	// ── Voice recording ───────────────────────────────────────────────
	// Tap mic → record → tap stop → POST blob to /api/transcribe → fill textarea.
	// Mic replaces Send when textarea is empty AND no attachments. Never auto-sends.
	let isRecording = $state(false);
	let isTranscribing = $state(false);
	let mediaRecorder: MediaRecorder | null = null;
	let recordedChunks: Blob[] = [];
	let mediaStream: MediaStream | null = null;

	const showMicButton = $derived(
		!value.trim() && attachedFiles.length === 0 && !isStreaming && !hasUploadingFiles
	);

	function releaseStream() {
		if (mediaStream) {
			mediaStream.getTracks().forEach((t) => t.stop());
			mediaStream = null;
		}
	}

	async function startRecording() {
		if (isRecording || isTranscribing) return;
		try {
			mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (e) {
			toast.error('Microphone permission denied');
			return;
		}

		recordedChunks = [];
		const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
			? 'audio/webm;codecs=opus'
			: MediaRecorder.isTypeSupported('audio/webm')
				? 'audio/webm'
				: '';
		mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);

		mediaRecorder.addEventListener('dataavailable', (e) => {
			if (e.data && e.data.size > 0) recordedChunks.push(e.data);
		});

		mediaRecorder.addEventListener('stop', async () => {
			releaseStream();
			const blob = new Blob(recordedChunks, { type: mimeType || 'audio/webm' });
			recordedChunks = [];
			if (blob.size === 0) {
				isTranscribing = false;
				return;
			}
			try {
				const { text } = await transcribeAudio(blob);
				const trimmed = text.trim();
				if (trimmed) {
					value = value ? `${value} ${trimmed}` : trimmed;
					// Resize textarea after content change.
					queueMicrotask(() => {
						if (chatInputElement) autoResizeTextarea(chatInputElement);
						chatInputElement?.focus();
					});
				} else {
					toast.warning('No speech detected');
				}
			} catch (err) {
				toast.error(`Transcription failed: ${err instanceof Error ? err.message : 'unknown'}`);
			} finally {
				isTranscribing = false;
			}
		});

		mediaRecorder.start();
		isRecording = true;
	}

	function stopRecording() {
		if (!isRecording || !mediaRecorder) return;
		isRecording = false;
		isTranscribing = true;
		try {
			mediaRecorder.stop();
		} catch {
			isTranscribing = false;
			releaseStream();
		}
	}

	function toggleRecording() {
		if (isRecording) stopRecording();
		else void startRecording();
	}

	function formatAttachmentPath(file: DisplayFile): string | null {
		if (!file.path) return null;

		const pathSegments = file.path.split('/');
		if (pathSegments.length <= 6) return file.path;
		return `.../${pathSegments.slice(-4).join('/')}`;
	}

	function autoResizeTextarea(textarea: HTMLTextAreaElement) {
		textarea.style.height = 'auto';
		const maxHeight = 200;
		textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
		textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
	}

	function resetTextareaHeight(textarea: HTMLTextAreaElement) {
		textarea.style.height = 'auto';
		textarea.style.overflowY = 'hidden';
	}

	function handleCommandKeydown(e: KeyboardEvent) {
		if (!showSlashCommands || filteredCommands.length === 0) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedCommandIndex = Math.min(selectedCommandIndex + 1, filteredCommands.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedCommandIndex = Math.max(selectedCommandIndex - 1, 0);
		} else if (e.key === 'Tab' || (e.key === 'Enter' && showSlashCommands)) {
			e.preventDefault();
			onSelectCommand(filteredCommands[selectedCommandIndex]);
		} else if (e.key === 'Escape') {
			showSlashCommands = false;
		}
	}

	export function clearFiles() {
		fileUploadComponent?.clearFiles();
	}

	export function resetHeight() {
		if (chatInputElement) resetTextareaHeight(chatInputElement);
	}

	export function focus() {
		chatInputElement?.focus();
	}

	export async function addFiles(files: FileList | File[]): Promise<void> {
		await fileUploadComponent?.addFiles(files);
	}

	export function hasPendingUploads(): boolean {
		return displayFiles.some((file) => file.status === 'uploading');
	}

	function removeFile(localId: string) {
		fileUploadComponent?.removeFile(localId);
	}

	async function handlePaste(e: ClipboardEvent) {
		const items = e.clipboardData?.items;
		if (!items) return;

		const imageFiles: File[] = [];
		for (const item of items) {
			if (item.type.startsWith('image/')) {
				const file = item.getAsFile();
				if (file) {
					imageFiles.push(new File([file], `pasted-image-${Date.now()}.png`, { type: file.type }));
				}
			}
		}

		if (imageFiles.length > 0) {
			e.preventDefault();
			await fileUploadComponent.addFiles(imageFiles);
		}
	}

	function getFileIcon(mimeType: string): string {
		if (mimeType.startsWith('image/')) return '🖼️';
		if (mimeType === 'application/pdf') return '📄';
		if (mimeType.startsWith('text/') || mimeType === 'application/json') return '📝';
		return '📎';
	}
</script>

<div class="chat-input-area">
	<div class="input-row">
		<div class="input-container">
			{#if displayFiles.length > 0}
				<div class="attachment-preview">
					{#each displayFiles as file}
						<div class="attachment-chip" class:uploading={file.status === 'uploading'} class:error={file.status === 'error'}>
							{#if file.previewUrl && file.mimeType.startsWith('image/')}
								<img src={file.previewUrl} alt={file.filename} class="attachment-thumb" />
							{:else}
								<span class="attachment-icon">{getFileIcon(file.mimeType)}</span>
							{/if}
							<span class="attachment-name" title={file.filename}>{file.filename}</span>
							{#if file.status === 'uploading'}
								<span class="attachment-spinner"></span>
							{:else if file.status === 'error'}
								<span class="attachment-error" title={file.error}>!</span>
							{/if}
							<button class="attachment-remove" onclick={() => removeFile(file.localId)} title="Remove">
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
									<path d="M18 6L6 18M6 6l12 12"/>
								</svg>
							</button>
						</div>
					{/each}
				</div>
				<div class="attachment-hint" aria-live="polite">
					{#if hasUploadingFiles}
						<span>Uploading to the Mac Mini local folder. Files will be passed to the CLI as filesystem paths.</span>
					{:else if uploadedDisplayFiles.length > 0}
						<span>Stored on the Mac Mini and passed to the CLI as local paths:</span>
						{#each uploadedDisplayFiles as file}
							<div class="attachment-path" title={file.path!}>
								{file.filename}: {formatAttachmentPath(file)}
							</div>
						{/each}
					{/if}
				</div>
			{/if}
			{#if showSlashCommands && filteredCommands.length > 0}
				<div class="slash-command-dropdown">
					{#each filteredCommands as cmd, i}
						<button
							class="slash-command-item"
							class:selected={i === selectedCommandIndex}
							onclick={() => onSelectCommand(cmd)}
						>
							<span class="cmd-name">{cmd.name}</span>
							{#if cmd.category === 'executor'}
								<span class="cmd-badge executor">switch</span>
							{:else if cmd.category === 'session'}
								<span class="cmd-badge session">session</span>
							{/if}
							<span class="cmd-desc">{cmd.description}</span>
						</button>
					{/each}
				</div>
			{/if}
			<div class="input-bottom-row">
				<FileUpload
					bind:this={fileUploadComponent}
					{sessionId}
					{ensureSessionForAttachments}
					onFilesChange={(files) => attachedFiles = files}
					onDisplayChange={(files) => displayFiles = files}
				/>
				<textarea
					placeholder="Ask me anything... (type / for commands)"
					class="chat-input"
					bind:value
					bind:this={chatInputElement}
					disabled={isStreaming}
					oninput={(e) => {
						onInputChange(e);
						autoResizeTextarea(e.target as HTMLTextAreaElement);
					}}
					onkeydown={(e) => {
						handleCommandKeydown(e);
						if (e.key === 'Enter' && !e.shiftKey && !showSlashCommands) {
							e.preventDefault();
							onSend();
						}
					}}
					onpaste={handlePaste}
					rows="1"
				></textarea>
				{#if showMicButton || isRecording || isTranscribing}
					<button
						class="send-btn mic-btn"
						class:recording={isRecording}
						class:transcribing={isTranscribing}
						onclick={toggleRecording}
						disabled={isTranscribing}
						aria-label={isRecording ? 'Stop recording' : isTranscribing ? 'Transcribing' : 'Start voice recording'}
						title={isRecording ? 'Tap to stop' : isTranscribing ? 'Transcribing…' : 'Voice input (local Whisper)'}
					>
						{#if isTranscribing}
							<span class="spinner-small"></span>
						{:else if isRecording}
							<!-- Stop square -->
							<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
								<rect x="4" y="4" width="16" height="16" rx="2"/>
							</svg>
						{:else}
							<!-- Mic icon -->
							<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
								<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/>
							</svg>
						{/if}
					</button>
				{:else}
					<button
						class="send-btn"
						onclick={onSend}
						disabled={(!value.trim() && attachedFiles.length === 0) || isStreaming || hasUploadingFiles}
						aria-label="Send"
					>
						{#if isStreaming}
							<span class="spinner-small"></span>
						{:else}
							<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
								<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
							</svg>
						{/if}
					</button>
				{/if}
			</div>
		</div>
	</div>
	<div class="input-disclaimer">
		AI-generated content may be incorrect
	</div>
</div>

<style>
	.chat-input-area {
		padding: 12px 24px;
		border-top: 1px solid #e0e0e0;
		background: white;
	}

	.input-row {
		display: flex;
		align-items: flex-end;
		gap: 8px;
		max-width: 900px;
		margin: 0 auto;
	}

	.input-container {
		display: flex;
		flex-direction: column;
		background: #f5f5f5;
		border: 1px solid #e0e0e0;
		border-radius: 8px;
		padding: 8px 8px 8px 12px;
		flex: 1;
		position: relative;
	}

	.input-container:focus-within {
		border-color: #0078d4;
		box-shadow: 0 0 0 1px #0078d4;
	}

	.input-bottom-row {
		display: flex;
		align-items: flex-end;
		gap: 8px;
	}

	/* Attachment preview */
	.attachment-preview {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		width: 100%;
		padding-bottom: 6px;
	}

	.attachment-hint {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding-bottom: 8px;
		font-size: 11px;
		color: #5f6b7a;
	}

	.attachment-path {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
		word-break: break-all;
	}

	.attachment-chip {
		display: flex;
		align-items: center;
		gap: 4px;
		background: #e8e8e8;
		border-radius: 6px;
		padding: 4px 6px;
		font-size: 12px;
		position: relative;
	}

	.attachment-chip.uploading {
		opacity: 0.7;
	}

	.attachment-chip.error {
		background: #fef2f2;
		border: 1px solid #fca5a5;
	}

	.attachment-thumb {
		width: 32px;
		height: 32px;
		object-fit: cover;
		border-radius: 4px;
	}

	.attachment-icon {
		font-size: 14px;
	}

	.attachment-name {
		max-width: 100px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.attachment-spinner {
		width: 12px;
		height: 12px;
		border: 1.5px solid #ccc;
		border-top-color: #0078d4;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	.attachment-error {
		color: #dc2626;
		font-weight: bold;
		font-size: 12px;
	}

	.attachment-remove {
		background: none;
		border: none;
		padding: 2px;
		cursor: pointer;
		color: #888;
		display: flex;
		border-radius: 2px;
	}

	.attachment-remove:hover {
		background: #d4d4d4;
		color: #333;
	}

	/* Slash command dropdown */
	.slash-command-dropdown {
		position: absolute;
		bottom: 100%;
		left: 0;
		right: 0;
		background: white;
		border: 1px solid #e0e0e0;
		border-radius: 8px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		margin-bottom: 4px;
		max-height: 240px;
		overflow-y: auto;
		z-index: 100;
	}

	.slash-command-item {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
		width: 100%;
		padding: 10px 14px;
		border: none;
		background: transparent;
		cursor: pointer;
		text-align: left;
		transition: background 0.1s;
	}

	.slash-command-item:hover,
	.slash-command-item.selected {
		background: #f0f4ff;
	}

	.slash-command-item .cmd-name {
		font-weight: 600;
		font-size: 14px;
		color: #0078d4;
	}

	.slash-command-item .cmd-desc {
		font-size: 12px;
		color: #666;
		width: 100%;
		flex-basis: 100%;
	}

	.slash-command-item .cmd-badge {
		font-size: 10px;
		padding: 2px 6px;
		border-radius: 10px;
		font-weight: 500;
		text-transform: uppercase;
	}

	.slash-command-item .cmd-badge.executor {
		background: #ddd6fe;
		color: #7c3aed;
	}

	.slash-command-item .cmd-badge.session {
		background: #fef3c7;
		color: #d97706;
	}

	.chat-input {
		flex: 1;
		border: none;
		background: transparent;
		font-size: 14px;
		padding: 8px 0;
		outline: none;
		resize: none;
		min-height: 24px;
		max-height: 200px;
		line-height: 1.5;
		font-family: inherit;
		overflow-y: hidden;
	}

	.chat-input::placeholder {
		color: #888;
	}

	.send-btn {
		width: 36px;
		height: 36px;
		border-radius: 4px;
		background: #0078d4;
		border: none;
		color: white;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s;
	}

	.send-btn:hover:not(:disabled) {
		background: #106ebe;
	}

	.send-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.mic-btn {
		background: #f5f5f5;
		color: #4b5563;
		border: 1px solid #e0e0e0;
	}

	.mic-btn:hover:not(:disabled) {
		background: #e8e8e8;
		color: #111827;
	}

	.mic-btn.recording {
		background: #dc2626;
		color: white;
		border-color: #dc2626;
		animation: mic-pulse 1.4s ease-in-out infinite;
	}

	.mic-btn.recording:hover {
		background: #b91c1c;
	}

	.mic-btn.transcribing {
		background: #0078d4;
		color: white;
		border-color: #0078d4;
	}

	@keyframes mic-pulse {
		0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.55); }
		50%      { box-shadow: 0 0 0 6px rgba(220, 38, 38, 0); }
	}

	.input-disclaimer {
		font-size: 11px;
		color: #888;
		margin-top: 8px;
		text-align: center;
	}

	.spinner-small {
		width: 16px;
		height: 16px;
		border: 2px solid rgba(255, 255, 255, 0.3);
		border-top-color: white;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>
