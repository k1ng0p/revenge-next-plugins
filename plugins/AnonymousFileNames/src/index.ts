import { getModules } from '@revenge-mod/modules/finders'
import { withProps } from '@revenge-mod/modules/finders/filters'
import { before } from '@revenge-mod/patcher'

import randStr from './lib/randomString'
import { getLen } from './lib/storage'
import SettingsPage from './settings'

function rename(file: any, len: number) {
	const f = file?.file ?? file
	const name = f?.filename ?? f?.name
	if (typeof name !== 'string') return

	const dot = name.lastIndexOf('.')
	const ext = dot !== -1 ? name.slice(dot) : ''
	if (dot === len && name.length === len + ext.length) return

	const newName = randStr(len) + ext
	if (f.filename) f.filename = newName
	if (f.name) f.name = newName
}

export default plugin({
	start({ cleanup }) {
		cleanup(getModules(withProps('uploadLocalFiles'), (mod) => {
			cleanup(before(mod, 'uploadLocalFiles', (args) => {
				const files = args[0]?.items ?? args[0]?.files ?? args[0]?.uploads
				if (Array.isArray(files)) files.forEach((f) => rename(f, getLen()))
				return args
			}))
		}))

		cleanup(getModules(withProps('CloudUpload'), (mod) => {
			cleanup(before(mod, 'CloudUpload', (args) => {
				if (args[0]) rename(args[0], getLen())
				return args
			}))
		}))
	},
	SettingsComponent: SettingsPage,
})
