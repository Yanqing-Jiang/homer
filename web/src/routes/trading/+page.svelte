<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { AuthOverlay, StatusBadge, EmptyState } from '$lib/components';
	import { useAuth } from '$lib/hooks/useAuth.svelte';
	import * as api from '$lib/api/client';
	import { toast } from '$lib/stores/toasts.svelte';

	const auth = useAuth();

	// Types
	interface TradingDashboard {
		health: {
			status: string;
			connected: boolean;
			running: boolean;
			timestamp: string;
		};
		pnl: {
			today: number;
			week: number;
			all_time: number;
			unrealized: number;
		};
		strategies: Strategy[];
		positions: Position[];
		trades: Trade[];
		timestamp: string;
	}

	interface Strategy {
		name: string;
		enabled: boolean;
		description: string;
		timeframe: string;
		total_signals: number;
		total_trades: number;
		win_rate: number;
		last_signal: string | null;
		running: boolean;
	}

	interface Position {
		symbol: string;
		strategy: string;
		quantity: number;
		side: string;
		avg_cost: number;
		entry_time: string;
		unrealized_pnl: number;
	}

	interface Trade {
		id: number;
		symbol: string;
		strategy: string;
		side: string;
		shares: number;
		entry_price: number;
		exit_price: number;
		entry_time: string;
		exit_time: string;
		profit: number;
		profit_pct: number;
		exit_reason: string;
	}

	// State
	let dashboard = $state<TradingDashboard | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let pollInterval = $state<ReturnType<typeof setInterval> | null>(null);
	let togglingStrategy = $state<string | null>(null);
	let startingService = $state(false);
	let stoppingService = $state(false);

	// Load dashboard data
	async function loadDashboard() {
		try {
			const data = await api.getTradingDashboard();
			dashboard = data as TradingDashboard;
			error = null;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load trading data';
			// Don't clear dashboard on error - keep showing stale data
		} finally {
			loading = false;
		}
	}

	// Start polling on mount
	onMount(() => {
		loadDashboard();
		// Poll every 5 seconds
		pollInterval = setInterval(loadDashboard, 5000);
	});

	// Stop polling on destroy
	onDestroy(() => {
		if (pollInterval) {
			clearInterval(pollInterval);
		}
	});

	// Format currency
	function formatCurrency(value: number): string {
		const sign = value >= 0 ? '+' : '';
		return `${sign}$${Math.abs(value).toFixed(2)}`;
	}

	// Get P&L color class
	function getPnlClass(value: number): string {
		if (value > 0) return 'positive';
		if (value < 0) return 'negative';
		return 'neutral';
	}

	// Toggle strategy
	async function toggleStrategy(strategy: Strategy) {
		togglingStrategy = strategy.name;
		try {
			if (strategy.enabled) {
				await api.stopTradingStrategy(strategy.name);
				toast.success(`Strategy ${strategy.name} disabled`);
			} else {
				await api.startTradingStrategy(strategy.name);
				toast.success(`Strategy ${strategy.name} enabled`);
			}
			await loadDashboard();
		} catch (e) {
			toast.error(`Failed to toggle strategy: ${e instanceof Error ? e.message : 'Unknown error'}`);
		} finally {
			togglingStrategy = null;
		}
	}

	// Start trading service
	async function startService() {
		startingService = true;
		try {
			await api.startTradingService({ symbols: ['QQQ', 'SPY'] });
			toast.success('Trading service started');
			await loadDashboard();
		} catch (e) {
			toast.error(`Failed to start service: ${e instanceof Error ? e.message : 'Unknown error'}`);
		} finally {
			startingService = false;
		}
	}

	// Stop trading service
	async function stopService() {
		stoppingService = true;
		try {
			await api.stopTradingService();
			toast.success('Trading service stopped');
			await loadDashboard();
		} catch (e) {
			toast.error(`Failed to stop service: ${e instanceof Error ? e.message : 'Unknown error'}`);
		} finally {
			stoppingService = false;
		}
	}
</script>

<svelte:head>
	<title>Trading | Homer</title>
</svelte:head>

{#if auth.loading}
	<div class="loading-screen">
		<div class="loading-content">
			<div class="loading-spinner"></div>
			<p>Loading...</p>
		</div>
	</div>
{:else if !auth.isAuthorized}
	<AuthOverlay />
{:else}
<div class="trading-page">
	<!-- Header -->
	<header class="page-header">
		<div class="header-content">
			<div class="header-left">
				<a href="/" class="back-link">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
						<path d="M19 12H5M12 19l-7-7 7-7"/>
					</svg>
				</a>
				<h1>Trading</h1>
				{#if dashboard?.health}
					<span class="status-indicator {dashboard.health.status}">
						{dashboard.health.status === 'connected' ? 'Connected' : 'Disconnected'}
					</span>
				{/if}
			</div>
			<div class="header-right">
				{#if dashboard?.health.running}
					<button class="stop-btn" onclick={stopService} disabled={stoppingService}>
						{stoppingService ? 'Stopping...' : 'Stop Trading'}
					</button>
				{:else}
					<button class="start-btn" onclick={startService} disabled={startingService}>
						{startingService ? 'Starting...' : 'Start Trading'}
					</button>
				{/if}
			</div>
		</div>
	</header>

	<!-- Error banner -->
	{#if error}
		<div class="error-banner">
			<span>{error}</span>
			<button onclick={() => error = null}>Dismiss</button>
		</div>
	{/if}

	{#if loading && !dashboard}
		<div class="loading">Loading trading data...</div>
	{:else if dashboard}
		<!-- P&L Cards -->
		<section class="pnl-section">
			<div class="pnl-cards">
				<div class="pnl-card">
					<span class="pnl-label">Today</span>
					<span class="pnl-value {getPnlClass(dashboard.pnl.today)}">
						{formatCurrency(dashboard.pnl.today)}
					</span>
				</div>
				<div class="pnl-card">
					<span class="pnl-label">This Week</span>
					<span class="pnl-value {getPnlClass(dashboard.pnl.week)}">
						{formatCurrency(dashboard.pnl.week)}
					</span>
				</div>
				<div class="pnl-card">
					<span class="pnl-label">All Time</span>
					<span class="pnl-value {getPnlClass(dashboard.pnl.all_time)}">
						{formatCurrency(dashboard.pnl.all_time)}
					</span>
				</div>
				<div class="pnl-card">
					<span class="pnl-label">Unrealized</span>
					<span class="pnl-value {getPnlClass(dashboard.pnl.unrealized)}">
						{formatCurrency(dashboard.pnl.unrealized)}
					</span>
				</div>
			</div>
		</section>

		<!-- Strategies -->
		<section class="section">
			<h2>Strategies</h2>
			<div class="strategies-grid">
				{#each dashboard.strategies as strategy}
					<div class="strategy-card">
						<div class="strategy-header">
							<div class="strategy-info">
								<h3>{strategy.name.replace(/_/g, ' ')}</h3>
								<span class="strategy-timeframe">{strategy.timeframe}</span>
							</div>
							<button
								class="toggle-btn {strategy.enabled ? 'enabled' : 'disabled'}"
								onclick={() => toggleStrategy(strategy)}
								disabled={togglingStrategy === strategy.name}
							>
								{strategy.enabled ? 'Enabled' : 'Disabled'}
							</button>
						</div>
						<p class="strategy-description">{strategy.description}</p>
						<div class="strategy-stats">
							<div class="stat">
								<span class="stat-value">{strategy.total_trades}</span>
								<span class="stat-label">Trades</span>
							</div>
							<div class="stat">
								<span class="stat-value">{strategy.total_signals}</span>
								<span class="stat-label">Signals</span>
							</div>
							<div class="stat">
								<span class="stat-value">{(strategy.win_rate * 100).toFixed(0)}%</span>
								<span class="stat-label">Win Rate</span>
							</div>
						</div>
						{#if strategy.running}
							<span class="running-badge">Running</span>
						{/if}
					</div>
				{/each}
			</div>
		</section>

		<!-- Positions -->
		<section class="section">
			<h2>Open Positions</h2>
			{#if dashboard.positions.length === 0}
				<div class="empty-state">
					<p>No open positions</p>
				</div>
			{:else}
				<div class="table-container">
					<table class="data-table">
						<thead>
							<tr>
								<th>Symbol</th>
								<th>Strategy</th>
								<th>Side</th>
								<th>Qty</th>
								<th>Avg Cost</th>
								<th>Unrealized P&L</th>
								<th>Entry Time</th>
							</tr>
						</thead>
						<tbody>
							{#each dashboard.positions as position}
								<tr>
									<td class="symbol">{position.symbol}</td>
									<td>{position.strategy}</td>
									<td class="side {position.side}">{position.side}</td>
									<td>{position.quantity}</td>
									<td>${position.avg_cost.toFixed(2)}</td>
									<td class="{getPnlClass(position.unrealized_pnl)}">
										{formatCurrency(position.unrealized_pnl)}
									</td>
									<td class="time">{new Date(position.entry_time).toLocaleString()}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<!-- Recent Trades -->
		<section class="section">
			<h2>Recent Trades</h2>
			{#if dashboard.trades.length === 0}
				<div class="empty-state">
					<p>No trades yet</p>
				</div>
			{:else}
				<div class="table-container">
					<table class="data-table">
						<thead>
							<tr>
								<th>Symbol</th>
								<th>Strategy</th>
								<th>Side</th>
								<th>Shares</th>
								<th>Entry</th>
								<th>Exit</th>
								<th>P&L</th>
								<th>Exit Reason</th>
								<th>Time</th>
							</tr>
						</thead>
						<tbody>
							{#each dashboard.trades as trade}
								<tr>
									<td class="symbol">{trade.symbol}</td>
									<td>{trade.strategy}</td>
									<td class="side {trade.side}">{trade.side}</td>
									<td>{trade.shares}</td>
									<td>${trade.entry_price.toFixed(2)}</td>
									<td>${trade.exit_price.toFixed(2)}</td>
									<td class="{getPnlClass(trade.profit)}">
										{formatCurrency(trade.profit)}
										<span class="pct">({trade.profit_pct >= 0 ? '+' : ''}{trade.profit_pct.toFixed(2)}%)</span>
									</td>
									<td class="reason">{trade.exit_reason}</td>
									<td class="time">{new Date(trade.exit_time).toLocaleString()}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<!-- Last Update -->
		<div class="last-update">
			Last updated: {new Date(dashboard.timestamp).toLocaleTimeString()}
		</div>
	{/if}
</div>
{/if}

<style>
	/* Loading screen */
	.loading-screen {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		background: #f2f2f2;
	}

	.loading-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		color: #666;
	}

	.loading-spinner {
		width: 32px;
		height: 32px;
		border: 3px solid #e6e6e6;
		border-top-color: #0078d4;
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.trading-page {
		min-height: 100vh;
		background: #f2f2f2;
		font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
	}

	/* Header */
	.page-header {
		background: #1b1b1b;
		padding: 0 24px;
		height: 56px;
		display: flex;
		align-items: center;
	}

	.header-content {
		width: 100%;
		max-width: 1400px;
		margin: 0 auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.header-left {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.back-link {
		color: #ccc;
		display: flex;
		align-items: center;
		padding: 8px;
		margin: -8px;
		border-radius: 4px;
		transition: all 0.15s;
	}

	.back-link:hover {
		color: white;
		background: rgba(255, 255, 255, 0.1);
	}

	h1 {
		color: white;
		font-size: 18px;
		font-weight: 600;
		margin: 0;
	}

	.status-indicator {
		font-size: 12px;
		padding: 4px 10px;
		border-radius: 12px;
		font-weight: 500;
	}

	.status-indicator.connected {
		background: #166534;
		color: #86efac;
	}

	.status-indicator.disconnected {
		background: #991b1b;
		color: #fecaca;
	}

	.start-btn, .stop-btn {
		padding: 8px 16px;
		border: none;
		border-radius: 4px;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s;
	}

	.start-btn {
		background: #22c55e;
		color: white;
	}

	.start-btn:hover:not(:disabled) {
		background: #16a34a;
	}

	.stop-btn {
		background: #ef4444;
		color: white;
	}

	.stop-btn:hover:not(:disabled) {
		background: #dc2626;
	}

	.start-btn:disabled, .stop-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Error banner */
	.error-banner {
		background: #fef2f2;
		border: 1px solid #fecaca;
		color: #b91c1c;
		padding: 12px 24px;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.error-banner button {
		background: none;
		border: none;
		color: #b91c1c;
		cursor: pointer;
		text-decoration: underline;
	}

	/* Loading */
	.loading {
		text-align: center;
		padding: 48px;
		color: #666;
	}

	/* P&L Section */
	.pnl-section {
		max-width: 1400px;
		margin: 0 auto;
		padding: 24px;
	}

	.pnl-cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 16px;
	}

	.pnl-card {
		background: white;
		border: 1px solid #e0e0e0;
		border-radius: 8px;
		padding: 20px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.pnl-label {
		font-size: 13px;
		color: #666;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.pnl-value {
		font-size: 28px;
		font-weight: 700;
	}

	.pnl-value.positive {
		color: #16a34a;
	}

	.pnl-value.negative {
		color: #dc2626;
	}

	.pnl-value.neutral {
		color: #666;
	}

	/* Sections */
	.section {
		max-width: 1400px;
		margin: 0 auto;
		padding: 0 24px 24px;
	}

	.section h2 {
		font-size: 16px;
		font-weight: 600;
		color: #1b1b1b;
		margin: 0 0 16px 0;
	}

	/* Strategies Grid */
	.strategies-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
		gap: 16px;
	}

	.strategy-card {
		background: white;
		border: 1px solid #e0e0e0;
		border-radius: 8px;
		padding: 20px;
		position: relative;
	}

	.strategy-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: 12px;
	}

	.strategy-info h3 {
		font-size: 15px;
		font-weight: 600;
		color: #1b1b1b;
		margin: 0;
		text-transform: capitalize;
	}

	.strategy-timeframe {
		font-size: 12px;
		color: #888;
	}

	.strategy-description {
		font-size: 13px;
		color: #666;
		margin: 0 0 16px 0;
	}

	.toggle-btn {
		padding: 6px 12px;
		border: none;
		border-radius: 4px;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s;
	}

	.toggle-btn.enabled {
		background: #dcfce7;
		color: #166534;
	}

	.toggle-btn.disabled {
		background: #f3f4f6;
		color: #666;
	}

	.toggle-btn:hover:not(:disabled) {
		opacity: 0.8;
	}

	.toggle-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.strategy-stats {
		display: flex;
		gap: 24px;
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.stat-value {
		font-size: 18px;
		font-weight: 600;
		color: #1b1b1b;
	}

	.stat-label {
		font-size: 11px;
		color: #888;
		text-transform: uppercase;
	}

	.running-badge {
		position: absolute;
		top: 12px;
		right: 12px;
		background: #dbeafe;
		color: #1e40af;
		font-size: 10px;
		font-weight: 600;
		padding: 4px 8px;
		border-radius: 4px;
		text-transform: uppercase;
	}

	/* Tables */
	.table-container {
		background: white;
		border: 1px solid #e0e0e0;
		border-radius: 8px;
		overflow-x: auto;
	}

	.data-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}

	.data-table th,
	.data-table td {
		padding: 12px 16px;
		text-align: left;
		border-bottom: 1px solid #e0e0e0;
	}

	.data-table th {
		background: #f9fafb;
		font-weight: 600;
		color: #374151;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}

	.data-table tbody tr:last-child td {
		border-bottom: none;
	}

	.data-table tbody tr:hover {
		background: #f9fafb;
	}

	.data-table .symbol {
		font-weight: 600;
		color: #1b1b1b;
	}

	.data-table .side {
		text-transform: uppercase;
		font-weight: 500;
	}

	.data-table .side.long {
		color: #16a34a;
	}

	.data-table .side.short {
		color: #dc2626;
	}

	.data-table .positive {
		color: #16a34a;
	}

	.data-table .negative {
		color: #dc2626;
	}

	.data-table .pct {
		font-size: 11px;
		opacity: 0.7;
	}

	.data-table .reason {
		color: #666;
	}

	.data-table .time {
		color: #888;
		font-size: 12px;
	}

	/* Empty State */
	.empty-state {
		background: white;
		border: 1px solid #e0e0e0;
		border-radius: 8px;
		padding: 32px;
		text-align: center;
		color: #666;
	}

	.empty-state p {
		margin: 0;
	}

	/* Last Update */
	.last-update {
		max-width: 1400px;
		margin: 0 auto;
		padding: 0 24px 24px;
		text-align: right;
		font-size: 12px;
		color: #888;
	}

	/* Mobile Responsiveness */
	@media (max-width: 768px) {
		.pnl-cards {
			grid-template-columns: repeat(2, 1fr);
		}

		.strategies-grid {
			grid-template-columns: 1fr;
		}

		.data-table {
			font-size: 12px;
		}

		.data-table th,
		.data-table td {
			padding: 8px 12px;
		}
	}

	@media (max-width: 480px) {
		.page-header {
			padding: 0 12px;
		}

		.pnl-section, .section {
			padding: 16px 12px;
		}

		.pnl-cards {
			grid-template-columns: 1fr 1fr;
			gap: 12px;
		}

		.pnl-card {
			padding: 16px;
		}

		.pnl-value {
			font-size: 22px;
		}
	}
</style>
