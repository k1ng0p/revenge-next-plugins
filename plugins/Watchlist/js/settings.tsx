import { getAssetIdByName } from '@revenge-mod/assets'
import Page from '@revenge-mod/components/Page'
import { Design } from '@revenge-mod/discord/design'
import { useState } from 'react'
import { DefaultSettings, getUserName, trackUser, untrackUser } from '.'
import type { PluginSettingsComponent } from '@revenge-mod/plugins/types'
import type { ComponentProps } from 'react'
import type { Settings } from '.'

const {
	Button,
	IconButton,
	TableRow,
	TableRowGroup,
	TableSwitchRow,
	TextInput,
} = Design

const Toggles: { key: 'status' | 'typing' | 'messages'; label: string }[] = [
	{ key: 'status', label: 'Status changes' },
	{ key: 'typing', label: 'Typing' },
	{ key: 'messages', label: 'New messages' },
]

type SettingsComponentProps = ComponentProps<
	PluginSettingsComponent<{ jsonStorage: Settings }>
>

export default function SettingsComponent({
	api: { jsonStorage: storage },
}: SettingsComponentProps) {
	const settings = { ...DefaultSettings, ...storage.use() }
	const [userId, setUserId] = useState('')

	return (
		<Page>
			<TableRowGroup title="Notify me about">
				{Toggles.map(({ key, label }) => (
					<TableSwitchRow
						key={key}
						label={label}
						value={settings[key]}
						onValueChange={value => storage.set({ [key]: value })}
					/>
				))}
			</TableRowGroup>
			<TextInput
				label="Track a user by ID"
				placeholder="User ID"
				value={userId}
				onChange={setUserId}
				isClearable
			/>
			<Button
				text="Add to Watchlist"
				icon={getAssetIdByName('UserPlusIcon')}
				onPress={async () => {
					if (await trackUser(userId.trim())) setUserId('')
				}}
			/>
			<TableRowGroup title={`Tracked users (${settings.users.length})`}>
				{settings.users.length ? (
					settings.users.map(id => (
						<TableRow
							key={id}
							label={getUserName(id)}
							subLabel={id}
							trailing={
								<IconButton
									icon={getAssetIdByName('UserMinusIcon')!}
									variant="tertiary"
									size="sm"
									onPress={() => untrackUser(id)}
								/>
							}
						/>
					))
				) : (
					<TableRow label="Nobody is on your Watchlist yet" />
				)}
			</TableRowGroup>
		</Page>
	)
}
