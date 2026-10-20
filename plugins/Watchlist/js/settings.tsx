import { getAssetIdByName } from '@revenge-mod/assets'
import Page from '@revenge-mod/components/Page'
import TableRowAssetIcon from '@revenge-mod/components/TableRowAssetIcon'
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

const Toggles: {
	key: 'status' | 'activity' | 'typing' | 'messages' | 'voice' | 'screenShare'
	label: string
	icon: string
}[] = [
	{ key: 'status', label: 'Status changes', icon: 'StatusIdle' },
	{
		key: 'activity',
		label: 'Activity (playing and listening: games, music, etc.)',
		icon: 'GameControllerIcon',
	},
	{ key: 'typing', label: 'Typing', icon: 'ChatDotsIcon' },
	{ key: 'messages', label: 'New messages', icon: 'ChatIcon' },
	{ key: 'voice', label: 'Joining voice channels', icon: 'VoiceNormalIcon' },
	{ key: 'screenShare', label: 'Screen sharing', icon: 'ScreenIcon' },
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
			<TableRowGroup title="Track">
				<TableSwitchRow
					label="Track friends"
					icon={<TableRowAssetIcon name="FriendsIcon" />}
					subLabel="Everyone on your friends list, besides the users you add"
					value={settings.friends}
					onValueChange={friends => storage.set({ friends })}
				/>
			</TableRowGroup>
			<TableRowGroup title="Notify me about">
				{Toggles.map(({ key, label, icon }) => (
					<TableSwitchRow
						key={key}
						label={label}
						icon={<TableRowAssetIcon name={icon} />}
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
