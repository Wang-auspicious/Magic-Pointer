<script lang="ts">
	import { Button } from "$lib/components/ui/button";
	import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
	import PauseIcon from "@lucide/svelte/icons/pause";
	import PlayIcon from "@lucide/svelte/icons/play";
	import SkipBackIcon from "@lucide/svelte/icons/skip-back";
	import SkipForwardIcon from "@lucide/svelte/icons/skip-forward";
	import TrashIcon from "@lucide/svelte/icons/trash";

	let sortBy = $state("");
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline">Open Menu</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content class="min-w-36">
		<DropdownMenu.Group>
			<DropdownMenu.Label>Playback</DropdownMenu.Label>
			<DropdownMenu.Item>
				<PlayIcon />
				Play
				<DropdownMenu.Shortcut>⌘P</DropdownMenu.Shortcut>
			</DropdownMenu.Item>
			<DropdownMenu.Item disabled>
				<PauseIcon />
				Pause
				<DropdownMenu.Shortcut>⇧⌘P</DropdownMenu.Shortcut>
			</DropdownMenu.Item>
			<DropdownMenu.Item>
				<SkipBackIcon />
				Previous
				<DropdownMenu.Shortcut>⌘[</DropdownMenu.Shortcut>
			</DropdownMenu.Item>
			<DropdownMenu.Item>
				<SkipForwardIcon />
				Next
				<DropdownMenu.Shortcut>⌘]</DropdownMenu.Shortcut>
			</DropdownMenu.Item>
		</DropdownMenu.Group>
		<DropdownMenu.Separator />
		<DropdownMenu.Item>Shuffle</DropdownMenu.Item>
		<DropdownMenu.Item>Repeat</DropdownMenu.Item>
		<DropdownMenu.Item disabled>Enhanced Audio</DropdownMenu.Item>
		<DropdownMenu.Separator />
		<DropdownMenu.Group>
			<DropdownMenu.Label>Sort By</DropdownMenu.Label>
			<DropdownMenu.RadioGroup bind:value={sortBy}>
				<DropdownMenu.RadioItem value="artist">Artist</DropdownMenu.RadioItem>
				<DropdownMenu.RadioItem value="album">Album</DropdownMenu.RadioItem>
				<DropdownMenu.RadioItem value="title">Title</DropdownMenu.RadioItem>
			</DropdownMenu.RadioGroup>
		</DropdownMenu.Group>
		<DropdownMenu.Separator />
		<DropdownMenu.CheckboxItem>Auto Save</DropdownMenu.CheckboxItem>
		<DropdownMenu.Separator />
		<DropdownMenu.Sub>
			<DropdownMenu.SubTrigger>Add to Playlist</DropdownMenu.SubTrigger>
			<DropdownMenu.SubContent align='start'>
				<DropdownMenu.Item>Jazz</DropdownMenu.Item>
				<!-- Rock -->
				<DropdownMenu.Sub>
					<DropdownMenu.SubTrigger>Rock</DropdownMenu.SubTrigger>
					<DropdownMenu.SubContent align='end'>
						<DropdownMenu.Item>Hard Rock</DropdownMenu.Item>
						<DropdownMenu.Item>Soft Rock</DropdownMenu.Item>
						<DropdownMenu.Item>Classic Rock</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item>Metal</DropdownMenu.Item>
						<DropdownMenu.Item>Punk</DropdownMenu.Item>
						<DropdownMenu.Item>Grunge</DropdownMenu.Item>
						<DropdownMenu.Item>Alternative</DropdownMenu.Item>
						<DropdownMenu.Item>Indie</DropdownMenu.Item>
						<DropdownMenu.Item>Electronic</DropdownMenu.Item>
					</DropdownMenu.SubContent>
				</DropdownMenu.Sub>
				<DropdownMenu.Item>Pop</DropdownMenu.Item>
			</DropdownMenu.SubContent>
		</DropdownMenu.Sub>
		<DropdownMenu.Separator />
		<DropdownMenu.Item variant="destructive">
			<TrashIcon />
			Delete
			<DropdownMenu.Shortcut>⌘⌫</DropdownMenu.Shortcut>
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
