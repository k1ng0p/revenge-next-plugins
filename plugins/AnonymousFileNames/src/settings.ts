import { Design } from '@revenge-mod/discord/design'
import { React } from '@revenge-mod/react'
import { Page } from '@revenge-mod/components'

import { DEFAULT_LEN, storage } from './lib/storage'

export default function SettingsPage() {
	const [text, setText] = React.useState(String(storage.cache?.nameLength ?? DEFAULT_LEN))

	return React.createElement(Page, null,
		React.createElement(Design.TextInput, {
			label: 'Filename length',
			placeholder: String(DEFAULT_LEN),
			value: text,
			onChange: (v: string) => {
				const digits = v.replace(/\D/g, '')
				setText(digits)
				storage.set({ nameLength: digits ? Math.max(1, Number(digits)) : DEFAULT_LEN })
			},
		}),
	)
}
