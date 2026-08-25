<script lang="ts">
	import { Button } from "$lib/components/ui/button";
	import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
	let theme = $state("light");
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline">Open Menu</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content>
		<DropdownMenu.RadioGroup bind:value={theme}>
			<DropdownMenu.RadioItem closeOnSelect={false} value="light">Light</DropdownMenu.RadioItem>
			<DropdownMenu.RadioItem closeOnSelect={false} value="dark">Dark</DropdownMenu.RadioItem>
			<DropdownMenu.RadioItem closeOnSelect={false} value="system">System</DropdownMenu.RadioItem>
		</DropdownMenu.RadioGroup>
	</DropdownMenu.Content>
</DropdownMenu.Root>
