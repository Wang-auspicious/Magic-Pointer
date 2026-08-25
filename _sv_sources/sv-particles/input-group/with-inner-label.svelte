<script lang="ts">
	import { Label } from "$lib/components/ui/field";
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import * as Popover from "$lib/components/ui/popover/index.js";
	import InfoIcon from "@lucide/svelte/icons/info";
</script>

<InputGroup.Root class="max-w-2xs">
	<InputGroup.Input placeholder="team@sv-particles.com" type="email" class='placeholder:text-sm'/>
	<InputGroup.Addon align="block-start" class="flex items-center justify-between py-0">
		<Label for="email-1" class="text-foreground">Email</Label>
		<Popover.Root>
			<Popover.Trigger closeDelay={0} openDelay={100} openOnHover>
				<InputGroup.Button variant="ghost" size="icon-xs">
					<InfoIcon />
				</InputGroup.Button>
			</Popover.Trigger>
			<Popover.Content side="top" class="px-2 py-1 text-xs w-fit">
					<p>We&apos;ll use this to send you notifications</p>
			</Popover.Content>
		</Popover.Root>
	</InputGroup.Addon>
</InputGroup.Root>
