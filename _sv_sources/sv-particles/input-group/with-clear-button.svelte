<script lang="ts">
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import XIcon from "@lucide/svelte/icons/x";

	let value = $state("Coding is fun");

	let clearValue = () => {
		value = "";
	};
</script>

<InputGroup.Root class="max-w-3xs">
	<InputGroup.Input placeholder="Search..." bind:value />
	{#if value}
		<InputGroup.Addon align="inline-end">
			<InputGroup.Button onclick={clearValue}>
				<XIcon />
			</InputGroup.Button>
		</InputGroup.Addon>
	{/if}
</InputGroup.Root>
