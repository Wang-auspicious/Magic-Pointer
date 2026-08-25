<script lang="ts">
	import InfoIcon from "@lucide/svelte/icons/info";
	import { Button } from "$lib/components/ui/button";
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import * as Tooltip from "$lib/components/ui/tooltip/index.js";
</script>

<InputGroup.Root class="max-w-3xs">
	<InputGroup.Input placeholder="Username" />
	<InputGroup.Addon>
		<Tooltip.Provider>
			<Tooltip.Root>
				<Tooltip.Trigger>
					<Button variant="ghost" size="icon-sm">
						<InfoIcon />
					</Button>
				</Tooltip.Trigger>
				<Tooltip.Content>
					<p>Tooltip content</p>
				</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	</InputGroup.Addon>
</InputGroup.Root>
