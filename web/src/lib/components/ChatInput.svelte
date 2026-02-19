<script lang="ts">
	import type { CommandDefinition, Upload } from '$lib/api/client';
	import FileUpload from './FileUpload.svelte';

	let {
		value = $bindable(''),
		isStreaming,
		sessionId,
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
</script>

<div class="chat-input-area">
	<div class="input-row">
		<FileUpload
			bind:this={fileUploadComponent}
			{sessionId}
			onFilesChange={(files) => attachedFiles = files}
		/>
		<div class="input-container">
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
				rows="1"
			></textarea>
			<button class="send-btn" onclick={onSend} disabled={!value.trim() || isStreaming} aria-label="Send">
				{#if isStreaming}
					<span class="spinner-small"></span>
				{:else}
					<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
						<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
					</svg>
				{/if}
			</button>
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
		align-items: flex-end;
		gap: 8px;
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
