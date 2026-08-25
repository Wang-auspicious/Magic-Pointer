<script lang="ts">
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import * as InputGroup from "$lib/components/ui/input-group/index.js";
	import * as Menubar from "$lib/components/ui/menubar/index.js";
	import EllipsisIcon from "@lucide/svelte/icons/ellipsis";
</script>

<InputGroup.Root class="max-w-xs">
	<InputGroup.Input placeholder="Type of search..." />
	<InputGroup.Addon align="inline-end">
		<Badge variant="secondary">Primary</Badge>
		<Menubar.Root class="border-none p-0">
			<Menubar.Menu>
				<Menubar.Trigger class="border-none p-0">
					<Button size="icon-xs" variant="ghost">
						<EllipsisIcon />
					</Button>
				</Menubar.Trigger>
				<Menubar.Content align="end" alignOffset={-4} sideOffset={8}>
					<Menubar.Item disabled>Make Primary</Menubar.Item>
					<Menubar.Item variant="destructive">Delete</Menubar.Item>
				</Menubar.Content>
			</Menubar.Menu>
		</Menubar.Root>
	</InputGroup.Addon>
</InputGroup.Root>
