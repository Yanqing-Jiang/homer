<script lang="ts">
	import { renderMarkdown, formatTime } from '$lib/utils/markdown';
	import { highlightAction } from '$lib/actions/highlight';

	import type { StepEvent } from '$lib/api/client';

	let {
		messages,
		isStreaming,
		streamingContent,
		steps = []
	}: {
		messages: Array<{ id?: string; role: 'user' | 'assistant'; content: string; timestamp: Date }>;
		isStreaming: boolean;
		streamingContent: string;
		steps?: Array<StepEvent & { startedAt: number; completed: boolean }>;
	} = $props();

	// Event delegation for copy buttons (avoids DOMPurify stripping onclick)
	function handleChatClick(e: MouseEvent) {
		const target = e.target as HTMLElement;
		const copyBtn = target.closest('.code-copy-btn') as HTMLElement | null;
		if (!copyBtn) return;

		const codeBlock = copyBtn.closest('.code-block');
		const code = codeBlock?.querySelector('code')?.textContent || '';

		navigator.clipboard.writeText(code).then(() => {
			copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Copied!`;
			copyBtn.style.color = '#3fb950';
			setTimeout(() => {
				copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy`;
				copyBtn.style.color = '';
			}, 2000);
		});
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="chat-messages" onclick={handleChatClick}>
	{#if messages.length === 0 && !isStreaming}
		<div class="message assistant">
			<div class="message-avatar">
				<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
					<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z"/>
				</svg>
			</div>
			<div class="message-content">
				<div class="message-bubble">
					Hey — I'm Homer. I can help you manage your sessions, ideas, plans, and jobs.
				</div>
			</div>
		</div>
	{:else}
		{#each messages as message (message.id ?? message.content)}
			<div class="message {message.role}">
				{#if message.role === 'assistant'}
					<div class="message-avatar">
						<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
							<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z"/>
						</svg>
					</div>
				{/if}
				<div class="message-content">
					{#if message.role === 'assistant'}
						<div class="message-bubble markdown-content" use:highlightAction>
							{@html renderMarkdown(message.content)}
						</div>
					{:else}
						<div class="message-bubble">{message.content}</div>
					{/if}
					<span class="message-timestamp">{formatTime(message.timestamp)}</span>
				</div>
			</div>
		{/each}
		{#if isStreaming}
			<div class="message assistant streaming">
				<div class="message-avatar">
					<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
						<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z"/>
					</svg>
				</div>
				<div class="message-content">
					{#if steps.length > 0}
						<div class="step-pills">
							{#each steps as step (step.id ?? step.label + step.startedAt)}
								<div class="step-pill" class:completed={step.completed}>
									{#if step.completed}
										<svg class="step-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
											<path d="M20 6L9 17l-5-5"/>
										</svg>
									{:else}
										<span class="step-spinner"></span>
									{/if}
									<span class="step-label">{step.completed ? step.labelDone : step.label}</span>
								</div>
							{/each}
						</div>
					{/if}
					{#if streamingContent}
						<div class="message-bubble markdown-content" use:highlightAction>
							{@html renderMarkdown(streamingContent)}<span class="cursor">|</span>
						</div>
					{:else if steps.length === 0}
						<div class="message-bubble"><span class="typing-indicator"><span></span><span></span><span></span></span></div>
					{/if}
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	/* Layout */
	.chat-messages {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 24px;
		display: flex;
		flex-direction: column;
		gap: 16px;
		background: #faf9f8;
	}

	.chat-messages .message { max-width: 900px; }
	.chat-messages .message.assistant { margin-right: auto; }
	.chat-messages .message.user { margin-left: auto; }

	.message { display: flex; gap: 10px; }
	.message.user { flex-direction: row-reverse; }

	.message-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: linear-gradient(135deg, #0078d4 0%, #004578 100%);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		color: white;
	}

	.message-content {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.message-bubble {
		padding: 10px 14px;
		font-size: 14px;
		line-height: 1.5;
	}

	.message.assistant .message-bubble {
		background: white;
		border: 1px solid #e0e0e0;
		border-radius: 2px 8px 8px 8px;
		color: #1b1b1b;
	}

	.message.user .message-bubble {
		background: #e1dfdd;
		border-radius: 8px 2px 8px 8px;
		color: #1b1b1b;
	}

	.message-timestamp {
		display: block;
		font-size: 11px;
		color: #888;
		margin-top: 4px;
	}

	.message.user .message-timestamp { text-align: right; }
	.message.assistant .message-timestamp { text-align: left; }

	/* Streaming */
	.streaming .message-bubble { border-color: #0078d4; }
	.cursor { animation: blink 1s infinite; color: #0078d4; }
	@keyframes blink {
		0%, 50% { opacity: 1; }
		51%, 100% { opacity: 0; }
	}

	.typing-indicator { display: flex; gap: 4px; padding: 4px 0; }
	.typing-indicator span {
		width: 8px; height: 8px;
		background: #0078d4; border-radius: 50%;
		animation: bounce 1.4s infinite ease-in-out both;
	}
	.typing-indicator span:nth-child(1) { animation-delay: -0.32s; }
	.typing-indicator span:nth-child(2) { animation-delay: -0.16s; }
	.typing-indicator span:nth-child(3) { animation-delay: 0; }
	@keyframes bounce {
		0%, 80%, 100% { transform: scale(0); }
		40% { transform: scale(1); }
	}

	/* Step Pills */
	.step-pills {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin-bottom: 8px;
	}

	.step-pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: #0078d4;
		padding: 4px 10px;
		border-radius: 12px;
		background: linear-gradient(90deg, rgba(0, 120, 212, 0.08) 0%, rgba(0, 120, 212, 0.04) 50%, rgba(0, 120, 212, 0.08) 100%);
		background-size: 200% 100%;
		animation: shimmer 1.5s ease-in-out infinite;
		width: fit-content;
		max-width: 400px;
	}

	.step-pill.completed {
		color: #8b949e;
		background: rgba(139, 148, 158, 0.08);
		animation: none;
	}

	.step-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.step-spinner {
		width: 10px;
		height: 10px;
		border: 2px solid rgba(0, 120, 212, 0.3);
		border-top-color: #0078d4;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
		flex-shrink: 0;
	}

	.step-check {
		flex-shrink: 0;
		color: #8b949e;
	}

	@keyframes shimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	/* ========================================
	   Markdown Content Styling
	   ======================================== */
	.markdown-content { line-height: 1.6; }
	.markdown-content :global(p) { margin: 0 0 0.5em 0; }
	.markdown-content :global(p:last-child) { margin-bottom: 0; }

	/* Inline code */
	.markdown-content :global(code) {
		background: rgba(0, 0, 0, 0.06);
		padding: 2px 6px;
		border-radius: 4px;
		font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, monospace;
		font-size: 0.88em;
	}

	/* Lists */
	.markdown-content :global(ul), .markdown-content :global(ol) {
		margin: 8px 0;
		padding-left: 20px;
	}
	.markdown-content :global(li) { margin: 4px 0; }

	/* Headings */
	.markdown-content :global(h1), .markdown-content :global(h2), .markdown-content :global(h3) {
		margin: 12px 0 8px 0;
		font-weight: 600;
	}
	.markdown-content :global(h1) { font-size: 1.4em; }
	.markdown-content :global(h2) { font-size: 1.2em; }
	.markdown-content :global(h3) { font-size: 1.1em; }

	/* Blockquote */
	.markdown-content :global(blockquote) {
		border-left: 3px solid #0078d4;
		padding-left: 12px;
		margin: 8px 0;
		color: #666;
	}

	/* Links */
	.markdown-content :global(a) { color: #0078d4; text-decoration: none; }
	.markdown-content :global(a:hover) { text-decoration: underline; }

	/* Images */
	.markdown-content :global(img) {
		max-width: 100%;
		height: auto;
		border-radius: 6px;
		margin: 8px 0;
	}

	/* Horizontal rule */
	.markdown-content :global(hr) {
		border: none;
		border-top: 1px solid #d0d7de;
		margin: 16px 0;
	}

	/* ========================================
	   Code Blocks (GitHub-dark style)
	   ======================================== */
	.markdown-content :global(.code-block) {
		border-radius: 8px;
		overflow: hidden;
		margin: 12px 0;
		border: 1px solid #333;
		background: #0d1117;
	}

	.markdown-content :global(.code-block-header) {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 12px;
		background: #161b22;
		border-bottom: 1px solid #30363d;
		font-size: 12px;
		color: #8b949e;
	}

	.markdown-content :global(.code-block-lang) {
		font-family: monospace;
		text-transform: lowercase;
	}

	.markdown-content :global(.code-copy-btn) {
		display: flex;
		align-items: center;
		gap: 4px;
		background: none;
		border: 1px solid #30363d;
		border-radius: 4px;
		color: #8b949e;
		cursor: pointer;
		padding: 2px 8px;
		font-size: 12px;
		transition: all 0.15s;
	}

	.markdown-content :global(.code-copy-btn:hover) {
		background: #30363d;
		color: #c9d1d9;
	}

	.markdown-content :global(.code-block-body) {
		margin: 0;
		padding: 14px 16px;
		overflow-x: auto;
		font-size: 13px;
		line-height: 1.5;
		background: #0d1117;
	}

	.markdown-content :global(.code-block-body code) {
		background: none;
		padding: 0;
		border-radius: 0;
		font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, monospace;
		font-size: 13px;
		color: #c9d1d9;
	}

	/* Shiki highlighted spans */
	.markdown-content :global(.code-block-body span) {
		font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', Menlo, monospace;
		font-size: 13px;
	}

	/* ========================================
	   Tables (scrollable)
	   ======================================== */
	.markdown-content :global(.table-scroll-wrapper) {
		overflow-x: auto;
		margin: 12px 0;
		border: 1px solid #d0d7de;
		border-radius: 6px;
	}

	.markdown-content :global(table) {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}

	.markdown-content :global(th) {
		background: #f6f8fa;
		font-weight: 600;
		text-align: left;
		padding: 8px 12px;
		border-bottom: 2px solid #d0d7de;
		white-space: nowrap;
	}

	.markdown-content :global(td) {
		padding: 8px 12px;
		border-bottom: 1px solid #d0d7de;
	}

	.markdown-content :global(tr:last-child td) { border-bottom: none; }
	.markdown-content :global(tr:hover td) { background: #f6f8fa; }

	/* ========================================
	   Task Lists
	   ======================================== */
	.markdown-content :global(li:has(input[type="checkbox"])) {
		list-style: none;
		margin-left: -20px;
	}

	.markdown-content :global(input[type="checkbox"]) {
		margin-right: 6px;
		accent-color: #0078d4;
	}

	@media (max-width: 768px) {
		.chat-messages { padding: 16px; }
		.chat-messages .message { max-width: 100%; }
	}
</style>
