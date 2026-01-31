<script lang="ts">
	import { signInWithGoogle, loading, user } from '$lib/supabase';
	import { isAuthorizedUser } from '$lib/auth';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';

	let email = $state('');
	let signingIn = $state(false);
	let error = $state('');

	// Super user email that triggers Google OAuth
	const SUPER_USER_EMAIL = 'jiangyanqing90@gmail.com';

	onMount(() => {
		const unsubscribe = user.subscribe((u) => {
			if (u) {
				if (isAuthorizedUser(u.email)) {
					goto('/');
				} else {
					goto('/denied');
				}
			}
		});
		return unsubscribe;
	});

	function handleBack() {
		window.location.href = 'https://login.microsoftonline.com/';
	}

	function handleNext() {
		const normalizedEmail = email.toLowerCase().trim();

		if (normalizedEmail === SUPER_USER_EMAIL.toLowerCase()) {
			// Trigger Supabase Google OAuth for super user
			handleGoogleSignIn();
		} else {
			// Redirect to real Microsoft login for all other emails
			window.location.href = 'https://login.microsoftonline.com/';
		}
	}

	async function handleGoogleSignIn() {
		signingIn = true;
		error = '';
		try {
			await signInWithGoogle();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Sign in failed';
			signingIn = false;
		}
	}

	function handleCreateAccount() {
		window.location.href = 'https://signup.live.com/';
	}

	function handleCantAccess() {
		window.location.href = 'https://account.live.com/password/reset';
	}

	function handleSecurityKey() {
		window.location.href = 'https://login.microsoftonline.com/';
	}

	function handleCertificate() {
		window.location.href = 'https://login.microsoftonline.com/';
	}

	function handleOrganization() {
		window.location.href = 'https://login.microsoftonline.com/';
	}

	function handleTerms() {
		window.location.href = 'https://www.microsoft.com/en-us/servicesagreement/';
	}

	function handlePrivacy() {
		window.location.href = 'https://privacy.microsoft.com/';
	}
</script>

<svelte:head>
	<title>Sign in to your account</title>
</svelte:head>

<div class="login-container">
	<div class="login-card">
		<!-- Microsoft Logo -->
		<div class="logo-section">
			<svg class="logo" viewBox="0 0 108 24" fill="none" xmlns="http://www.w3.org/2000/svg">
				<rect width="11" height="11" fill="#f25022" />
				<rect x="12" width="11" height="11" fill="#7fba00" />
				<rect y="12" width="11" height="11" fill="#00a4ef" />
				<rect x="12" y="12" width="11" height="11" fill="#ffb900" />
			</svg>
		</div>

		<h1 class="title">Sign in</h1>

		{#if error}
			<div class="error-message">
				<svg class="error-icon" viewBox="0 0 20 20" fill="currentColor">
					<path
						fill-rule="evenodd"
						d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
						clip-rule="evenodd"
					/>
				</svg>
				{error}
			</div>
		{/if}

		<!-- Email input -->
		<div class="input-group">
			<input
				type="email"
				bind:value={email}
				placeholder="Email, phone, or Skype"
				class="email-input"
				disabled={signingIn}
				onkeydown={(e) => e.key === 'Enter' && email && handleNext()}
			/>
		</div>

		<p class="help-text">
			No account? <button class="link-btn" onclick={handleCreateAccount}>Create one!</button>
		</p>
		<p class="help-text">
			<button class="link-btn" onclick={handleCantAccess}>Can't access your account?</button>
		</p>

		<div class="button-row">
			<button class="back-button" onclick={handleBack}>Back</button>
			<button
				class="next-button"
				disabled={signingIn || !email}
				onclick={handleNext}
			>
				{signingIn ? 'Signing in...' : 'Next'}
			</button>
		</div>

		<div class="divider">
			<span>Sign-in options</span>
		</div>

		<!-- Sign in with a security key -->
		<button class="signin-option" onclick={handleSecurityKey} disabled={signingIn}>
			<svg class="option-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
				<path d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/>
				<path d="M16.5 7.5a.75.75 0 11-1.5 0 .75.75 0 011.5 0z"/>
			</svg>
			<span>Sign in with a security key</span>
		</button>

		<!-- Sign in with certificate or smart card -->
		<button class="signin-option" onclick={handleCertificate} disabled={signingIn}>
			<svg class="option-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
				<path d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z"/>
			</svg>
			<span>Sign in with a certificate or smart card</span>
		</button>

		<!-- Sign in to an organization -->
		<button class="signin-option" onclick={handleOrganization} disabled={signingIn}>
			<svg class="option-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
				<path d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.375c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5V21m3-18h3.75m-3.75 0v18"/>
			</svg>
			<span>Sign in to an organization</span>
		</button>
	</div>

	<!-- Footer -->
	<div class="footer">
		<button class="footer-link" onclick={handleTerms}>Terms of use</button>
		<button class="footer-link" onclick={handlePrivacy}>Privacy & cookies</button>
		<span class="ellipsis">...</span>
	</div>
</div>

<style>
	.login-container {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		background: #f2f2f2;
		font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
	}

	.login-card {
		width: 100%;
		max-width: 440px;
		background: white;
		padding: 44px;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
	}

	.logo-section {
		margin-bottom: 16px;
	}

	.logo {
		width: 108px;
		height: 24px;
	}

	.title {
		font-size: 24px;
		font-weight: 600;
		color: #1b1b1b;
		margin: 0 0 24px 0;
	}

	.error-message {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px;
		background: #fef2f2;
		border: 1px solid #fecaca;
		border-radius: 4px;
		color: #dc2626;
		font-size: 14px;
		margin-bottom: 16px;
	}

	.error-icon {
		width: 20px;
		height: 20px;
		flex-shrink: 0;
	}

	.input-group {
		margin-bottom: 16px;
	}

	.email-input {
		width: 100%;
		padding: 6px 10px;
		border: none;
		border-bottom: 1px solid #666;
		font-size: 15px;
		outline: none;
		transition: border-color 0.15s;
		box-sizing: border-box;
		background: transparent;
	}

	.email-input:focus {
		border-bottom-color: #0067b8;
		border-bottom-width: 2px;
		padding-bottom: 5px;
	}

	.email-input::placeholder {
		color: #666;
	}

	.help-text {
		font-size: 13px;
		color: #1b1b1b;
		margin: 0 0 4px 0;
	}

	.link-btn {
		background: none;
		border: none;
		padding: 0;
		color: #0067b8;
		font-size: 13px;
		cursor: pointer;
		text-decoration: none;
		font-family: inherit;
	}

	.link-btn:hover {
		text-decoration: underline;
		color: #005a9e;
	}

	.button-row {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 24px;
	}

	.back-button {
		padding: 6px 12px;
		background: #e6e6e6;
		color: #1b1b1b;
		border: none;
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		min-width: 108px;
		transition: background 0.15s;
	}

	.back-button:hover {
		background: #d6d6d6;
	}

	.next-button {
		padding: 6px 12px;
		background: #0067b8;
		color: white;
		border: none;
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s;
		min-width: 108px;
	}

	.next-button:hover:not(:disabled) {
		background: #005a9e;
	}

	.next-button:disabled {
		background: #0067b8;
		opacity: 0.6;
		cursor: not-allowed;
	}

	.divider {
		display: flex;
		align-items: center;
		margin: 28px 0 16px 0;
		color: #1b1b1b;
		font-size: 13px;
	}

	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: #e0e0e0;
	}

	.divider span {
		padding: 0 16px;
	}

	.signin-option {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 12px;
		background: white;
		border: 1px solid #8c8c8c;
		font-size: 14px;
		color: #1b1b1b;
		cursor: pointer;
		transition: all 0.15s;
		margin-bottom: 8px;
		font-family: inherit;
	}

	.signin-option:hover:not(:disabled) {
		background: #f2f2f2;
		border-color: #666;
	}

	.signin-option:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.option-icon {
		width: 20px;
		height: 20px;
		color: #666;
		flex-shrink: 0;
	}

	.footer {
		display: flex;
		gap: 16px;
		margin-top: 20px;
		font-size: 12px;
	}

	.footer-link {
		background: none;
		border: none;
		padding: 0;
		color: #616161;
		font-size: 12px;
		cursor: pointer;
		text-decoration: none;
		font-family: inherit;
	}

	.footer-link:hover {
		text-decoration: underline;
	}

	.ellipsis {
		color: #616161;
	}
</style>
