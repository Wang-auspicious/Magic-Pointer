<script lang="ts">
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import Label from "$lib/components/ui/label/label.svelte";
	import EyeIcon from "@lucide/svelte/icons/eye";
	import EyeOffIcon from "@lucide/svelte/icons/eye-off";
	import CheckIcon from "@lucide/svelte/icons/check";
	import XIcon from "@lucide/svelte/icons/x";

	const requirements = $state([
		{ regex: /.{8,}/, text: "At least 8 characters" },
		{ regex: /[0-9]/, text: "At least 1 number" },
		{ regex: /[a-z]/, text: "At least 1 lowercase letter" },
		{ regex: /[A-Z]/, text: "At least 1 uppercase letter" },
	]);

	let strength = $derived(
		requirements.map((req) => ({
			met: req.regex.test(password),
			text: req.text,
		}))
	);

	let password = $state("");
	let isVisible = $state(false);

	function toggleVisibility() {
		isVisible = !isVisible;
	}

	let strengthScore = $derived.by(() => {
		return strength.filter((req) => req.met).length;
	});

	let getStrengthColor = (score: number) => {
		if (score === 0) return "bg-border";
		if (score <= 1) return "bg-red-500";
		if (score <= 2) return "bg-orange-500";
		if (score === 3) return "bg-amber-500";
		return "bg-emerald-500";
	};
	const getStrengthText = (score: number) => {
		if (score === 0) return "Enter a password";
		if (score <= 2) return "Weak password";
		if (score === 3) return "Medium password";
		return "Strong password";
	};

	let id = "password-input";
</script>

<div class="flex flex-col gap-3">
	<div class="flex flex-col gap-2">
		<Label>Password</Label>
		<InputGroup.Root>
			<InputGroup.Input
				placeholder="Password"
				type={isVisible ? "text" : "password"}
				bind:value={password}
			/>
			<InputGroup.Addon align="inline-end">
				<InputGroup.Button size="icon-xs" variant="ghost" onclick={toggleVisibility}>
					{#if isVisible}
						<EyeOffIcon />
					{:else}
						<EyeIcon />
					{/if}
				</InputGroup.Button>
			</InputGroup.Addon>
		</InputGroup.Root>
	</div>
	<div
		aria-label="Password strength"
		aria-valuemax={4}
		aria-valuemin={0}
		aria-valuenow={strengthScore}
		class="h-1 w-full overflow-hidden rounded-full bg-border"
		role="progressbar"
		tabIndex={-1}
	>
		<div
			class={`h-full ${getStrengthColor(strengthScore)} transition-all duration-500 ease-out`}
			style={`width: ${(strengthScore / 4) * 100}%`}
		></div>
	</div>
	<p class="text-sm font-medium text-foreground" id={`${id}-description`}>
		{getStrengthText(strengthScore)}. Must contain:
	</p>
	<ul aria-label="Password requirements" class="flex flex-col gap-1.5">
		{#each strength as req}
			<li class="flex items-center gap-2">
				{#if req.met}
					<CheckIcon class="size-4 text-emerald-500" />
				{:else}
					<XIcon class="size-4 text-muted-foreground/80" />
				{/if}
				<span class={["text-xs", req.met ? "text-emerald-600" : "text-muted-foreground"]}>
					{req.text}
					<span class="sr-only">
						{req.met ? " - Requirement met" : " - Requirement not met"}
					</span>
				</span>
			</li>
		{/each}
	</ul>
</div>
