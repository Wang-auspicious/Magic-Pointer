<script lang="ts">
	import { Button } from "$lib/components/ui/button";
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import * as Popover from "$lib/components/ui/popover/index.js";
	import InfoIcon from "@lucide/svelte/icons/info";
	import StarIcon from "@lucide/svelte/icons/star";

	let isFavorite = $state(false);
</script>

<InputGroup.Root class="max-w-3xs rounded-full">
	<InputGroup.Input
		placeholder="search..."
		type="search"
		class="placeholder:text-sm [input]:ps-0!"
	/>
	<!-- Info Icon Prefix -->
	<InputGroup.Addon>
		<Popover.Root>
			<Popover.Trigger openDelay={100} closeDelay={0} class="w-full">
				<Button variant="ghost" size="icon-xs" class="rounded-full!">
					<InfoIcon />
				</Button>
			</Popover.Trigger>
			<Popover.Content alignOffset={-5} sideOffset={8} align="start" class="w-64 p-2">
				<Popover.Title class="text-sm">Your connection is not secure</Popover.Title>
				<Popover.Description>
					You should not enter any sensitive information on this site.
				</Popover.Description>
			</Popover.Content>
		</Popover.Root>
	</InputGroup.Addon>
	<InputGroup.Addon>
		<InputGroup.Text class="text-muted-foreground">https://</InputGroup.Text>
	</InputGroup.Addon>
	<InputGroup.Addon align="inline-end">
		<Button
			size="icon-xs"
			variant="ghost"
			class="rounded-full"
			onclick={() => (isFavorite = !isFavorite)}
		>
			<StarIcon
				data-favorite={isFavorite}
				class="data-[favorite=true]:fill-primary data-[favorite=true]:stroke-primary"
			/>
		</Button>
	</InputGroup.Addon>
</InputGroup.Root>
