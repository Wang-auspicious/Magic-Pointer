<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as ButtonGroup from '$lib/components/ui/button-group';
	import QrCodeIcon from '@lucide/svelte/icons/qr-code';
</script>

<ButtonGroup.Root>
	<Button>
		<QrCodeIcon />
	</Button>
	<Button>Sign In</Button>
</ButtonGroup.Root>
