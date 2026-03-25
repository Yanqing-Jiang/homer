<script lang="ts">
	import { fade } from 'svelte/transition';
	import type { SessionSearchResult } from '$lib/api/client';
	import { formatRelativeTime } from '$lib/utils/date';

	interface Props {
		results: SessionSearchResult[];
		loading: boolean;
		query: string;
		selectedIndex: number;
		onselect: (session: SessionSearchResult) => void;
		onclose: () => void;
	}

	let {
		results,
		loading,
		query,
		selectedIndex = $bindable(-1),
		onselect,
		onclose
	}: Props = $props();

	function truncate(text: string, length = 100) {
		if (text.length <= length) return text;
		return text.substring(0, length) + '...';
	}

	/** Strip all HTML tags except <mark> (from FTS5 snippet) to prevent XSS */
	function sanitizeSnippet(html: string): string {
		return html.replace(/<(?!\/?mark\b)[^>]*>/gi, '');
	}
</script>

<div class="dropdown-container" transition:fade={{ duration: 100 }}>
	{#if loading}
		<div class="state-message">
			<div class="spinner"></div>
			<span>Searching sessions...</span>
		</div>
	{:else if results.length === 0}
		<div class="state-message empty">
			<span>No sessions found for "<strong>{query}</strong>"</span>
		</div>
	{:else}
		<div class="results-list" role="listbox">
			{#each results as session, i}
				<button
					class="result-row"
					class:selected={i === selectedIndex}
					role="option"
					aria-selected={i === selectedIndex}
					onmousedown={(e) => { e.preventDefault(); onselect(session); }}
					onmouseenter={() => (selectedIndex = i)}
				>
					<div class="icon-col">
						<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
							<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
						</svg>
					</div>
					<div class="content-col">
						<div class="title-row">
							<span class="session-name">{session.name}</span>
							<span class="timestamp">{formatRelativeTime(session.updatedAt)}</span>
						</div>
						{#if session.snippet}
							<div class="snippet">{@html sanitizeSnippet(truncate(session.snippet))}</div>
						{:else}
							<div class="snippet meta">{session.threadCount} thread{session.threadCount !== 1 ? 's' : ''}</div>
						{/if}
					</div>
				</button>
			{/each}
		</div>

		<div class="dropdown-footer">
			<span><strong>Enter</strong> select &middot; <strong>&uarr;&darr;</strong> navigate &middot; <strong>Esc</strong> close</span>
		</div>
	{/if}
</div>

<style>
	.dropdown-container {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		background: #ffffff;
		border: 1px solid #d1d1d1;
		border-radius: 4px;
		box-shadow: 0 6.4px 14.4px 0 rgba(0, 0, 0, 0.132), 0 1.2px 3.6px 0 rgba(0, 0, 0, 0.108);
		z-index: 1000;
		overflow: hidden;
		font-family: 'Segoe UI', system-ui, sans-serif;
	}

	.results-list {
		max-height: 480px;
		overflow-y: auto;
		padding: 4px 0;
	}

	.result-row {
		display: flex;
		width: 100%;
		padding: 8px 12px;
		border: none;
		background: transparent;
		cursor: pointer;
		text-align: left;
		transition: background 0.1s;
		gap: 10px;
		align-items: flex-start;
	}

	.result-row:hover,
	.result-row.selected {
		background-color: #e5f1fb;
	}

	.result-row.selected {
		background-color: #cce4f7;
	}

	.icon-col {
		margin-top: 2px;
		color: #0078d4;
		flex-shrink: 0;
	}

	.content-col {
		flex: 1;
		min-width: 0;
	}

	.title-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 2px;
	}

	.session-name {
		font-size: 13px;
		font-weight: 600;
		color: #1b1b1b;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.timestamp {
		font-size: 11px;
		color: #666;
		white-space: nowrap;
		margin-left: 8px;
		flex-shrink: 0;
	}

	.snippet {
		font-size: 12px;
		color: #616161;
		line-height: 1.4;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.snippet.meta {
		color: #888;
		font-style: italic;
	}

	:global(.snippet mark) {
		background: transparent;
		color: #0078d4;
		font-weight: 600;
		padding: 0;
	}

	.state-message {
		padding: 20px;
		text-align: center;
		color: #666;
		font-size: 13px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
	}

	.state-message.empty {
		padding: 16px;
	}

	.dropdown-footer {
		padding: 6px 12px;
		background: #f3f2f1;
		border-top: 1px solid #e1e1e1;
		font-size: 11px;
		color: #888;
	}

	.spinner {
		width: 18px;
		height: 18px;
		border: 2px solid #c7e0f4;
		border-top-color: #0078d4;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>
