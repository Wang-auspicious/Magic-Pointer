<script lang="ts">
	import { Button } from "$lib/components/ui/button";
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import * as Popover from "$lib/components/ui/popover/index.js";
	import InfoIcon from "@lucide/svelte/icons/info";
</script>

<InputGroup.Root class="max-w-3xs">
	<InputGroup.Input
		placeholder="search..."
		type="search"
		class="placeholder:text-sm [input]:ps-0!"
	/>
	<InputGroup.Addon>
		<InputGroup.Text>https://</InputGroup.Text>
	</InputGroup.Addon>
	<InputGroup.Addon align="inline-end">
		<Popover.Root>
			<Popover.Trigger openOnHover openDelay={100} closeDelay={0} class="w-full">
				<Button variant="ghost" size="icon-xs">
					<InfoIcon />
				</Button>
			</Popover.Trigger>
			<Popover.Content side="top" sideOffset={8} class='py-1 px-2 text-xs w-fit'>
				<p>The URL of your website</p>
			</Popover.Content>
		</Popover.Root>
	</InputGroup.Addon>
</InputGroup.Root>
