import Page from '@revenge-mod/components/Page'
import TableRowAssetIcon from '@revenge-mod/components/TableRowAssetIcon'
import { Design } from '@revenge-mod/discord/design'
import type { PluginSettingsComponent } from '@revenge-mod/plugins/types'
import type { ComponentProps } from 'react'
import type { Settings } from '.'

type SettingComponentProps = ComponentProps<
	PluginSettingsComponent<{ jsonStorage: Settings }>
>

export default function SettingsComponent({
	api: { jsonStorage: storage },
}: SettingComponentProps) {
	const { TableRowGroup, TableSwitchRow } = Design
	const { bio } = storage.use()!

	return (
		<Page>
			<TableRowGroup>
				<TableSwitchRow
					icon={<TableRowAssetIcon name="ReactionIcon" />}
					label="React and reply to bios"
					subLabel="Long-press a friend's bio on their profile to react or reply."
					value={bio ?? true}
					onValueChange={bio => storage.set({ bio })}
				/>
			</TableRowGroup>
		</Page>
	)
}