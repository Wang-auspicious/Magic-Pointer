<script lang="ts">
	import * as Table from "$lib/components/ui/table/index.js";

	type Item = {
		id: string;
		name: string;
		email: string;
		status: string;
		balance: string;
		location: string;
		username: string;
		image: string;
	};
	const items: Item[] = [
		{
			id: "1",
			name: "Bhide Svelte",
			email: "bhidesvelte@company.com",
			status: "Active",
			balance: "$1,250.00",
			location: "San Francisco, US",
			username: "bhide_svelte",
			image: "https://github.com/SikandarJODD.png",
		},
		{
			id: "2",
			name: "Hunter Johnston",
			email: "hunter.j@company.com",
			status: "Active",
			balance: "$4000.00",
			location: "Singapore",
			username: "hunterjohnston",
			image: "https://github.com/huntabyte.png",
		},
		{
			id: "3",
			name: "Ever",
			email: "ever@company.com",
			status: "Inactive",
			balance: "$1600.00",
			location: "London, UK",
			username: "ruizdiazever",
			image: "https://github.com/ruizdiazever.png",
		},
		{
			id: "4",
			name: "Maria Garcia",
			email: "m.garcia@company.com",
			status: "Active",
			balance: "$0.00",
			location: "Madrid, Spain",
			username: "mariagarcia",
			image: "https://i.pinimg.com/736x/f4/07/5d/f4075d3fdfdf01e3162a845403fdce5f.jpg",
		},
	];
</script>

<div class="mx-auto w-4xl py-10">
	<Table.Root class="w-full">
		<Table.Caption>Table with Images</Table.Caption>
		<Table.Header>
			<Table.Row>
				<Table.Head>Name</Table.Head>
				<Table.Head>Email</Table.Head>
				<Table.Head>Location</Table.Head>
				<Table.Head>Status</Table.Head>
				<Table.Head class="text-end">Balance</Table.Head>
			</Table.Row>
		</Table.Header>
		<Table.Body>
			{#each items as item}
				<Table.Row>
					<Table.Cell>
						<div class="flex items-center gap-3">
							<img
								alt={item.name}
								class="rounded-full"
								height={40}
								src={item.image}
								width={40}
							/>
							<div>
								<div class="font-medium">{item.name}</div>
								<span class="mt-0.5 text-muted-foreground text-xs">
									{item.username}
								</span>
							</div>
						</div>
					</Table.Cell>
					<Table.Cell>{item.email}</Table.Cell>
					<Table.Cell>{item.location}</Table.Cell>
					<Table.Cell>{item.status}</Table.Cell>
					<Table.Cell class="text-end">{item.balance}</Table.Cell>
				</Table.Row>
			{/each}
		</Table.Body>
	</Table.Root>
</div>
