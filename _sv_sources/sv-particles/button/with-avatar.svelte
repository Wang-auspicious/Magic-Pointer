<script lang="ts">
	import * as Avatar from '$lib/components/ui/avatar/index.js';
	import { Button } from '$lib/components/ui/button';
</script>

<Button class="rounded-full ps-1">
	<Avatar.Root class="size-6">
		<Avatar.Image src="https://images.unsplash.com/photo-1543610892-0b1f7e6d8ac1?w=96&h=96&dpr=2&q=80" alt="@SikandarJODD" />
		<Avatar.Fallback>SB</Avatar.Fallback>
	</Avatar.Root>
	@SikandarJODD
</Button>
