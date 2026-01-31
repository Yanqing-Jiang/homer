<script lang="ts">
	import { user, signOut } from '$lib/supabase';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { ALLOWED_EMAIL, isAuthorizedUser } from '$lib/auth';

	onMount(() => {
		const unsubscribe = user.subscribe((u) => {
			if (u && isAuthorizedUser(u.email)) {
				goto('/');
			} else if (!u) {
				goto('/login');
			}
		});
		return unsubscribe;
	});

	async function handleUseAnotherAccount() {
		await signOut();
		window.location.href = 'https://login.microsoftonline.com/';
	}

	function handleBackToAzure() {
		window.location.href = 'https://login.microsoftonline.com/';
	}
</script>

<svelte:head>
	<title>Access Denied</title>
</svelte:head>

<div class="denied-container">
	<div class="denied-card">
		<!-- Microsoft Logo -->
		<div class="logo-section">
			<svg class="logo" viewBox="0 0 23 23" fill="none" xmlns="http://www.w3.org/2000/svg">
				<rect width="11" height="11" fill="#f25022" />
				<rect x="12" width="11" height="11" fill="#7fba00" />
				<rect y="12" width="11" height="11" fill="#00a4ef" />
				<rect x="12" y="12" width="11" height="11" fill="#ffb900" />
			</svg>
		</div>

		<!-- Error Icon -->
		<div class="error-icon-container">
			<svg class="error-icon" viewBox="0 0 24 24" fill="none" stroke="#d13438" stroke-width="2">
				<circle cx="12" cy="12" r="10" />
				<line x1="15" y1="9" x2="9" y2="15" />
				<line x1="9" y1="9" x2="15" y2="15" />
			</svg>
		</div>

		<h1 class="title">You cannot access this right now</h1>

		<div class="account-info">
			{#if $user}
				<div class="account-avatar">
					{#if $user.user_metadata?.avatar_url}
						<img src={$user.user_metadata.avatar_url} alt="Avatar" class="avatar" />
					{:else}
						<div class="avatar-placeholder">
							{$user.email?.[0].toUpperCase() || 'U'}
						</div>
					{/if}
				</div>
				<div class="account-details">
					<span class="account-name">{$user.user_metadata?.full_name || $user.email}</span>
					<span class="account-email">{$user.email}</span>
				</div>
			{/if}
		</div>

		<p class="description">
			Your account <strong>{$user?.email}</strong> doesn't have access to this application.
			The account needs to be added by an administrator before you can sign in.
		</p>

		<p class="description secondary">
			If you have multiple accounts, try signing in with a different account.
		</p>

		<div class="button-row">
			<button class="back-button" onclick={handleBackToAzure}>Back</button>
			<button class="use-another-button" onclick={handleUseAnotherAccount}>
				Use another account
			</button>
		</div>

		<div class="help-section">
			<p>Having trouble? <a href="https://support.microsoft.com" class="link">Get help</a></p>
		</div>
	</div>

	<!-- Footer -->
	<div class="footer">
		<a href="https://www.microsoft.com/en-us/servicesagreement/">Terms of use</a>
		<a href="https://privacy.microsoft.com/">Privacy & cookies</a>
		<span class="ellipsis">...</span>
	</div>
</div>

<style>
	.denied-container {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		background: #f2f2f2;
		font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
	}

	.denied-card {
		width: 100%;
		max-width: 440px;
		background: white;
		padding: 44px;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
	}

	.logo-section {
		margin-bottom: 24px;
	}

	.logo {
		width: 108px;
		height: 24px;
	}

	.error-icon-container {
		margin-bottom: 16px;
	}

	.error-icon {
		width: 48px;
		height: 48px;
	}

	.title {
		font-size: 24px;
		font-weight: 600;
		color: #1b1b1b;
		margin: 0 0 24px 0;
	}

	.account-info {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px;
		background: #faf9f8;
		border: 1px solid #edebe9;
		margin-bottom: 16px;
	}

	.avatar {
		width: 40px;
		height: 40px;
		border-radius: 50%;
	}

	.avatar-placeholder {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: #0078d4;
		color: white;
		display: flex;
		align-items: center;
		justify-content: center;
		font-weight: 600;
	}

	.account-details {
		display: flex;
		flex-direction: column;
	}

	.account-name {
		font-weight: 600;
		color: #1b1b1b;
		font-size: 14px;
	}

	.account-email {
		color: #616161;
		font-size: 12px;
	}

	.description {
		font-size: 14px;
		color: #1b1b1b;
		margin: 0 0 12px 0;
		line-height: 1.5;
	}

	.description.secondary {
		color: #616161;
	}

	.button-row {
		display: flex;
		gap: 8px;
		margin-top: 24px;
	}

	.back-button {
		flex: 1;
		padding: 10px 16px;
		background: #e6e6e6;
		color: #1b1b1b;
		border: none;
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s;
	}

	.back-button:hover {
		background: #d6d6d6;
	}

	.use-another-button {
		flex: 1;
		padding: 10px 16px;
		background: #0067b8;
		color: white;
		border: none;
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s;
	}

	.use-another-button:hover {
		background: #005a9e;
	}

	.help-section {
		margin-top: 24px;
		padding-top: 16px;
		border-top: 1px solid #e6e6e6;
	}

	.help-section p {
		font-size: 13px;
		color: #616161;
		margin: 0;
	}

	.link {
		color: #0067b8;
		text-decoration: none;
	}

	.link:hover {
		text-decoration: underline;
	}

	.footer {
		display: flex;
		gap: 16px;
		margin-top: 20px;
		font-size: 12px;
	}

	.footer a {
		color: #616161;
		text-decoration: none;
	}

	.footer a:hover {
		text-decoration: underline;
	}

	.ellipsis {
		color: #616161;
	}
</style>
