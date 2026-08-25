<script lang="ts">
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import * as Popover from "$lib/components/ui/popover/index.js";
	import InfoIcon from "@lucide/svelte/icons/info";
</script>

<InputGroup.Root class="max-w-3xs">
	<InputGroup.Input placeholder="Password" class="placeholder:text-sm" type="password" />
	<InputGroup.Addon align="inline-end">
		<Popover.Root>
			<Popover.Trigger closeDelay={0} openDelay={100} openOnHover>
				<InputGroup.Button variant="ghost" size="icon-xs">
					<InfoIcon />
				</InputGroup.Button>
			</Popover.Trigger>
			<Popover.Content side="top" sideOffset={8} class="w-fit px-2 py-1 text-xs"
				>Min. 8 characters</Popover.Content
			>
		</Popover.Root>
	</InputGroup.Addon>
</InputGroup.Root>
