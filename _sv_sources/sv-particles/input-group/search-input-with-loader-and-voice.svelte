<script lang="ts">
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import * as Tooltip from "$lib/components/ui/tooltip/index.js";
	import SearchIcon from "@lucide/svelte/icons/search";
	import MicIcon from "@lucide/svelte/icons/mic";
	import { Spinner } from "$lib/components/ui/spinner";

	let value = $state("");
	let isLoading = $state(false);

	$effect(() => {
		if (value) {
			isLoading = true;
			let timer = setTimeout(() => {
				isLoading = false;
			}, 500);
			return () => clearTimeout(timer);
		}
		isLoading = false;
	});
</script>

<InputGroup.Root class="max-w-xs">
	<InputGroup.Addon>
		{#if isLoading}
			<Spinner />
		{:else}
			<SearchIcon />
		{/if}
	</InputGroup.Addon>
	<InputGroup.Input placeholder="Search..." bind:value />
	<InputGroup.Addon align="inline-end">
		<Tooltip.Provider>
			<Tooltip.Root>
				<Tooltip.Trigger>
					<InputGroup.Button variant="ghost" size="icon-xs">
						<MicIcon />
					</InputGroup.Button>
				</Tooltip.Trigger>
				<Tooltip.Content>Voice search</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	</InputGroup.Addon>
</InputGroup.Root>
