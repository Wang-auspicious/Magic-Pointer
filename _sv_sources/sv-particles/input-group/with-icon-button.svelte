<script lang="ts">
	import CheckIcon from "@lucide/svelte/icons/check";
	import CopyIcon from "@lucide/svelte/icons/copy";
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import * as Tooltip from "$lib/components/ui/tooltip/index.js";
	import { UseClipboard } from "$lib/hooks/use-clipboard.svelte";

	let value = $state("https://sv-particles.vercel.app");

	// https://www.shadcn-svelte-extras.com/docs/hooks/use-clipboard
	let clipboard = new UseClipboard();
</script>

<InputGroup.Root class="max-w-2xs">
	<InputGroup.Input bind:value placeholder="https://sv-particles.vercel.app" class='text-sm' type="text" />
	<InputGroup.Addon align="inline-end">
		<!-- <InputGroup.Button>Search</InputGroup.Button> -->
		<Tooltip.Provider>
			<Tooltip.Root delayDuration={0}>
				<Tooltip.Trigger class="border-none! bg-transparent! p-0!">
					<InputGroup.Button
						onclick={() => clipboard.copy(value)}
						size="icon-xs"
						variant="ghost"
					>
						{#if clipboard.copied}
							<CheckIcon />
						{:else}
							<CopyIcon />
						{/if}
					</InputGroup.Button>
				</Tooltip.Trigger>
				<Tooltip.Content>
					<p>Copy to clipboard</p>
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	</InputGroup.Addon>
</InputGroup.Root>
