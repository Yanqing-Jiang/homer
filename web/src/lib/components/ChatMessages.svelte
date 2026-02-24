<script lang="ts">
	let {
		messages,
		isStreaming,
		streamingContent,
		renderMarkdown,
		formatTime
	}: {
		messages: Array<{ id?: string; role: 'user' | 'assistant'; content: string; timestamp: Date }>;
		isStreaming: boolean;
		streamingContent: string;
		renderMarkdown: (content: string) => string;
		formatTime: (date: Date) => string;
	} = $props();
</script>

<div class="chat-messages">
	{#if messages.length === 0 && !isStreaming}
		<!-- Welcome Message -->
		<div class="message assistant">
			<div class="message-avatar">
				<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
					<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z"/>
				</svg>
			</div>
			<div class="message-content">
				<div class="message-bubble">
					Hi! I'm Azure AI. I can help you manage your sessions, ideas, plans, and jobs. What would you like to do?
				</div>
			</div>
		</div>
	{:else}
		{#each messages as message}
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
						<div class="message-bubble markdown-content">{@html renderMarkdown(message.content)}</div>
					{:else}
						<div class="message-bubble">{message.content}</div>
					{/if}
				<span class="message-timestamp">{formatTime(message.timestamp)}</span>
				</div>
			</div>
		{/each}
		{#if isStreaming && streamingContent}
			<div class="message assistant streaming">
				<div class="message-avatar">
					<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
						<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z"/>
					</svg>
				</div>
				<div class="message-content">
					<div class="message-bubble markdown-content">{@html renderMarkdown(streamingContent)}<span class="cursor">|</span></div>
				</div>
			</div>
		{:else if isStreaming}
			<div class="message assistant streaming">
				<div class="message-avatar">
					<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
						<path d="M12 2L9.5 9.5L2 12L9.5 14.5L12 22L14.5 14.5L22 12L14.5 9.5L12 2Z"/>
					</svg>
				</div>
				<div class="message-content">
					<div class="message-bubble"><span class="typing-indicator"><span></span><span></span><span></span></span></div>
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
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

	.chat-messages .message {
		max-width: 900px;
	}

	.chat-messages .message.assistant {
		margin-right: auto;
	}

	.chat-messages .message.user {
		margin-left: auto;
	}

	.message {
		display: flex;
		gap: 10px;
	}

	.message.user {
		flex-direction: row-reverse;
	}

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

	.message.user .message-timestamp {
		text-align: right;
	}

	.message.assistant .message-timestamp {
		text-align: left;
	}

	/* Streaming and typing indicators */
	.streaming .message-bubble {
		border-color: #0078d4;
	}

	.cursor {
		animation: blink 1s infinite;
		color: #0078d4;
	}

	@keyframes blink {
		0%, 50% { opacity: 1; }
		51%, 100% { opacity: 0; }
	}

	.typing-indicator {
		display: flex;
		gap: 4px;
		padding: 4px 0;
	}

	.typing-indicator span {
		width: 8px;
		height: 8px;
		background: #0078d4;
		border-radius: 50%;
		animation: bounce 1.4s infinite ease-in-out both;
	}

	.typing-indicator span:nth-child(1) { animation-delay: -0.32s; }
	.typing-indicator span:nth-child(2) { animation-delay: -0.16s; }
	.typing-indicator span:nth-child(3) { animation-delay: 0; }

	@keyframes bounce {
		0%, 80%, 100% { transform: scale(0); }
		40% { transform: scale(1); }
	}

	/* Markdown content styling */
	.markdown-content {
		line-height: 1.6;
	}

	.markdown-content :global(p) {
		margin: 0 0 0.5em 0;
	}

	.markdown-content :global(p:last-child) {
		margin-bottom: 0;
	}

	.markdown-content :global(code) {
		background: rgba(0, 0, 0, 0.05);
		padding: 2px 6px;
		border-radius: 3px;
		font-family: monospace;
		font-size: 0.9em;
	}

	.markdown-content :global(pre) {
		background: #1e1e1e;
		color: #d4d4d4;
		padding: 12px;
		border-radius: 6px;
		overflow-x: auto;
		margin: 8px 0;
	}

	.markdown-content :global(pre code) {
		background: none;
		padding: 0;
		color: inherit;
	}

	.markdown-content :global(ul), .markdown-content :global(ol) {
		margin: 8px 0;
		padding-left: 20px;
	}

	.markdown-content :global(li) {
		margin: 4px 0;
	}

	.markdown-content :global(h1), .markdown-content :global(h2), .markdown-content :global(h3) {
		margin: 12px 0 8px 0;
		font-weight: 600;
	}

	.markdown-content :global(h1) { font-size: 1.4em; }
	.markdown-content :global(h2) { font-size: 1.2em; }
	.markdown-content :global(h3) { font-size: 1.1em; }

	.markdown-content :global(blockquote) {
		border-left: 3px solid #0078d4;
		padding-left: 12px;
		margin: 8px 0;
		color: #666;
	}

	.markdown-content :global(a) {
		color: #0078d4;
		text-decoration: none;
	}

	.markdown-content :global(a:hover) {
		text-decoration: underline;
	}

	@media (max-width: 768px) {
		.chat-messages {
			padding: 16px;
		}

		.chat-messages .message {
			max-width: 100%;
		}
	}
</style>
