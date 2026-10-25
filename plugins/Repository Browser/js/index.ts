import * as settings from '@revenge-mod/discord/modules/settings'
import { ReactNative } from '@revenge-mod/react'
import { RepoCount } from './components'
import { bindStore, checkedRecently, checkUpdates, restore } from './data'
import { Browser } from './settings'
import { KEY, POLL_INTERVAL, bindReporter, icon, reportError } from './shared'

export default plugin({
	jsonStorage: { load: true, default: { seen: {}, ack: 0, snaps: {}, remote: null, known: null, newRepos: {}, updatesSeen: null, alerts: {}, muted: {} } },
	SettingsComponent: Browser,
	start({ cleanup, plugin, jsonStorage }) {
		try {
			if (plugin.startedLate) plugin.requireReload()
			bindStore(jsonStorage)
			bindReporter(error => plugin.reportError(error))
			restore()

			const undo: (() => void)[] = []
			let retry: ReturnType<typeof setTimeout> | undefined
			let attempts = 0
			let stopped = false

			const poll = () => checkUpdates().catch(error => reportError(error, 'check for updates'))
			poll().then(() => settings.refreshSettings())

			const interval = setInterval(poll, POLL_INTERVAL)
			const appState = ReactNative.AppState.addEventListener('change', (next: string) => {
				if (next === 'active' && !checkedRecently()) poll()
			})

			// there is no way to ask whether the section exists, so add an item and drop it again
			const revengeSectionExists = () => {
				try {
					settings.addSettingsItemToSection('REVENGE', items => items)()
					return true
				} catch {
					// the Revenge section isn't registered yet
					return false
				}
			}

			// sections are laid out in registration order, ours has to go in after Revenge's own
			const placeSection = () => {
				if (stopped) return
				if (!revengeSectionExists()) {
					attempts++
					if (attempts < 20) Promise.resolve().then(placeSection)
					else if (attempts < 500) retry = setTimeout(placeSection, 20)
					return
				}
				undo.push(
					settings.registerSettingsSection
						? settings.registerSettingsSection(KEY, { label: 'Plugin Browser', settings: [KEY], index: 1 })
						: settings.addSettingsItemToSection('REVENGE', KEY),
				)
				settings.refreshSettings()
			}

			const off = settings.onSettingsModulesLoaded(() => {
				undo.push(
					settings.registerSettingsItems({
						[KEY]: {
							type: 'route',
							parent: null,
							IconComponent: () => icon('ic_browse_channel'),
							useTitle: () => 'Community Plugins',
							useTrailing: RepoCount,
							screen: { route: KEY, getComponent: () => Browser },
						},
					}),
				)
				placeSection()
			})

			cleanup(off, () => {
				stopped = true
				clearTimeout(retry)
				clearInterval(interval)
				appState.remove()
				undo.splice(0).forEach(fn => fn())
				settings.refreshSettings()
			})
		} catch (e) {
			plugin.reportError(e)
		}
	},
})
