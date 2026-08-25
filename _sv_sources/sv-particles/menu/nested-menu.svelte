<script lang="ts">
	import { Button } from "$lib/components/ui/button";
	import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline">Open Menu</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content>
		<DropdownMenu.Item>Item one</DropdownMenu.Item>
		<DropdownMenu.Sub>
			<DropdownMenu.SubTrigger>More</DropdownMenu.SubTrigger>
			<DropdownMenu.SubContent align="start" class='min-w-36'>
				<DropdownMenu.Item>Sub item A</DropdownMenu.Item>
				<DropdownMenu.Item>Sub item B</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item>More...</DropdownMenu.Item>
			</DropdownMenu.SubContent>
		</DropdownMenu.Sub>
		<DropdownMenu.Item>Item two</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
