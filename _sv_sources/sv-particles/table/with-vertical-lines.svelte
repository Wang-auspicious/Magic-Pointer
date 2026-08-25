<script lang="ts">
	import * as Table from "$lib/components/ui/table/index.js";

	const items = [
		{
			balance: "$1,250.00",
			email: "alex.t@company.com",
			id: "1",
			location: "San Francisco, US",
			name: "Alex Thompson",
			status: "Active",
		},
		{
			balance: "$600.00",
			email: "sarah.c@company.com",
			id: "2",
			location: "Singapore",
			name: "Sarah Chen",
			status: "Active",
		},
		{
			balance: "$650.00",
			email: "j.wilson@company.com",
			id: "3",
			location: "London, UK",
			name: "James Wilson",
			status: "Inactive",
		},
		{
			balance: "$0.00",
			email: "m.garcia@company.com",
			id: "4",
			location: "Madrid, Spain",
			name: "Maria Garcia",
			status: "Active",
		},
		{
			balance: "-$1,000.00",
			email: "d.kim@company.com",
			id: "5",
			location: "Seoul, KR",
			name: "David Kim",
			status: "Active",
		},
	];
</script>

<div class="mx-auto w-5xl py-10">
	<Table.Root class="w-full">
		<Table.Caption>Table with vertical lines</Table.Caption>
		<Table.Header>
			<Table.Row class="*:border-border hover:bg-transparent [&>:not(:last-child)]:border-r">
				<Table.Head>Name</Table.Head>
				<Table.Head>Email</Table.Head>
				<Table.Head>Location</Table.Head>
				<Table.Head>Status</Table.Head>
				<Table.Head class="text-end">Balance</Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each items as item}
				<Table.Row
					class="*:border-border hover:bg-transparent [&>:not(:last-child)]:border-r"
				>
					<Table.Cell class="py-2.5 font-medium">{item.name}</Table.Cell>
					<Table.Cell class="py-2.5">{item.email}</Table.Cell>
					<Table.Cell class="py-2.5">{item.location}</Table.Cell>
					<Table.Cell class="py-2.5">{item.status}</Table.Cell>
					<Table.Cell class="py-2.5 text-end">{item.balance}</Table.Cell>
				</Table.Row>
			{/each}
		</Table.Body>
		<!-- <Table.Footer class="bg-transparent">
			<Table.Row class="hover:bg-transparent">
				<Table.Cell colspan={4}>Total</Table.Cell>
				<Table.Cell class="text-right">$2,500.00</Table.Cell>
			</Table.Row>
		</Table.Footer> -->
	</Table.Root>
</div>
