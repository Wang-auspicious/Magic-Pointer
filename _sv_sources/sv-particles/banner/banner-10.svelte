<script lang="ts">
	import { onMount } from 'svelte';
	import TicketPercentIcon from '@lucide/svelte/icons/ticket-percent';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';

	type TimeLeft = {
		days: number;
		hours: number;
		minutes: number;
		seconds: number;
		isExpired: boolean;
	};

	let isVisible = $state(true);
	let saleEndTimestamp = Date.now() + 9 * 60 * 60 * 1000 + 45 * 60 * 1000 + 24 * 1000;
	let timeLeft = $state<TimeLeft>({
		days: 0,
		hours: 0,
		minutes: 0,
		seconds: 0,
		isExpired: false
	});

	function calculateTimeLeft() {
		const difference = saleEndTimestamp - Date.now();

		if (difference <= 0) {
			timeLeft = {
				days: 0,
				hours: 0,
				minutes: 0,
				seconds: 0,
				isExpired: true
			};
			return;
		}

		timeLeft = {
			days: Math.floor(difference / (1000 * 60 * 60 * 24)),
			hours: Math.floor((difference % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
			minutes: Math.floor((difference % (1000 * 60 * 60)) / (1000 * 60)),
			seconds: Math.floor((difference % (1000 * 60)) / 1000),
			isExpired: false
		};
	}

	onMount(() => {
		calculateTimeLeft();
		const timer = window.setInterval(calculateTimeLeft, 1000);

		return () => window.clearInterval(timer);
	});
</script>

{#if isVisible && !timeLeft.isExpired}
	<div class="dark w-full bg-muted px-4 py-3 text-foreground">
		<div class="flex gap-2 md:items-center">
			<div class="flex grow gap-3 md:items-center">
				<div
					aria-hidden="true"
					class="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 max-md:mt-0.5"
				>
					<TicketPercentIcon class="opacity-80" size={16} />
				</div>
				<div class="flex grow flex-col justify-between gap-3 md:flex-row md:items-center">
					<div class="space-y-0.5">
						<p class="text-sm font-medium">Black Friday Sale!</p>
						<p class="text-sm text-muted-foreground">
							It kicks off today and is available for just 24 hours, don't miss out!
						</p>
					</div>
					<div class="flex gap-3 max-md:flex-wrap">
						<div
							class="flex items-center divide-x divide-primary-foreground rounded-md bg-primary/15 text-sm tabular-nums"
						>
							{#if timeLeft.days > 0}
								<span class="flex h-8 items-center justify-center p-2">
									{timeLeft.days}<span class="text-muted-foreground">d</span>
								</span>
							{/if}
							<span class="flex h-8 items-center justify-center p-2">
								{timeLeft.hours.toString().padStart(2, '0')}<span class="text-muted-foreground"
									>h</span
								>
							</span>
							<span class="flex h-8 items-center justify-center p-2">
								{timeLeft.minutes.toString().padStart(2, '0')}<span
									class="text-muted-foreground">m</span
								>
							</span>
							<span class="flex h-8 items-center justify-center p-2">
								{timeLeft.seconds.toString().padStart(2, '0')}<span
									class="text-muted-foreground">s</span
								>
							</span>
						</div>
						<Button class="text-sm" size="sm">Buy now</Button>
					</div>
				</div>
			</div>
			<Button
				aria-label="Close banner"
				class="group -my-1.5 -me-2 size-8 shrink-0 p-0 hover:bg-transparent"
				onclick={() => (isVisible = false)}
				variant="ghost"
			>
				<XIcon
					aria-hidden="true"
					class="opacity-60 transition-opacity group-hover:opacity-100"
					size={16}
				/>
			</Button>
		</div>
	</div>
{/if}
