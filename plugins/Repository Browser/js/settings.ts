import { FormSwitch, SearchInput } from '@revenge-mod/components'
import { Design } from '@revenge-mod/discord/design'
import { React, ReactNative } from '@revenge-mod/react'
import { FeedSection, Notice, PluginCard, RepoAvatar, RepoBadges } from './components'
import type { CardUpdate } from './components'
import {
	catalog,
	checkUpdates,
	dependentsOf,
	discordUser,
	dismiss,
	dismissAll,
	dismissRepo,
	freshAvatarEpoch,
	listings,
	openUserProfile,
	parseAuthor,
	repoOwner,
	save,
	setAlertMode,
	useStore,
} from './data'
import type { SeenEntry } from './data'
import { available, install, openPluginSettings, pendingReload, putRepos, readState, toggle, uninstall, updatePlugins } from './revenge'
import type { RevengeState } from './revenge'
import { ALERT_MODES, DAY, PAGE_SIZE, SORTS, ago, asset, fail, formatSize, friendlyError, h, hostOf, icon, modal, reportError, slash } from './shared'
import type { AlertMode, AvailableUpdate, ListedPlugin, Repo, SortKey } from './shared'

type Hit = { repo: Repo; plugin: ListedPlugin }
type Ctx = ReturnType<typeof useBrowser>

// a switch flip stays visible until Revenge reports the new state
const toggled = new Map<string, { value: boolean; before: boolean }>()

function useBrowser() {
	const { View, BackHandler } = ReactNative
	const { Button, ContextMenu, IconButton, Text } = Design

	const data = useStore()
	const seen: Record<string, SeenEntry> = data?.seen ?? {}
	const newRepos: Record<string, number> = data?.newRepos ?? {}
	const [current, setCurrent] = React.useState<Repo | null>(null)
	const [detail, setDetail] = React.useState<{ repo: Repo; id: string } | null>(null)
	const [updatingIds, setUpdatingIds] = React.useState<string[]>([])
	const [authorNames, setAuthorNames] = React.useState<Record<string, string>>({})
	const [state, setState] = React.useState<RevengeState | null>(null)
	const [installing, setInstalling] = React.useState('')
	const [query, setQuery] = React.useState('')
	const [sort, setSort] = React.useState<SortKey>('default')
	const [limit, setLimit] = React.useState(PAGE_SIZE)
	const [refreshing, setRefreshing] = React.useState(false)
	const [retrying, setRetrying] = React.useState('')
	const [reloadingRepo, setReloadingRepo] = React.useState(false)
	const [booting, setBooting] = React.useState(true)
	const [epoch, setEpoch] = React.useState(() => freshAvatarEpoch())
	const [, rerender] = React.useReducer((n: number) => n + 1, 0)

	const syncState = () =>
		readState()
			.then(next => {
				for (const [id, change] of toggled) if ((next.enabled[id]?.enabled ?? false) !== change.before) toggled.delete(id)
				setState(next)
			})
			.catch(reportError)

	const afterToggle = (id: string, value: boolean) => {
		toggled.set(id, { value, before: state?.enabled[id]?.enabled ?? false })
		syncState()
	}

	const refreshAll = async () => {
		if (refreshing) return
		setRefreshing(true)
		setEpoch(freshAvatarEpoch(true))
		try {
			await checkUpdates(undefined, rerender)
			await syncState()
			await save({ ack: Date.now() })
		} finally {
			setRefreshing(false)
		}
	}

	const refreshCurrent = async () => {
		if (!current || reloadingRepo) return
		setReloadingRepo(true)
		try {
			await checkUpdates([current.url], rerender)
			await syncState()
		} finally {
			setReloadingRepo(false)
		}
	}

	const retry = async (repo: Repo) => {
		setRetrying(repo.url)
		try {
			await checkUpdates([repo.url], rerender)
		} finally {
			setRetrying('')
		}
	}

	const showRepo = (repo: Repo) => {
		setQuery('')
		setCurrent(repo)
	}

	const showList = () => {
		setQuery('')
		setCurrent(null)
	}

	React.useEffect(() => {
		let mounted = true
		save({ ack: Date.now() })
		syncState()
		checkUpdates(undefined, () => mounted && rerender())
			.catch(reportError)
			.then(() => {
				if (!mounted) return
				save({ ack: Date.now() })
				setBooting(false)
			})
		return () => {
			mounted = false
		}
	}, [])

	React.useEffect(() => {
		const id = current?.discord
		if (!id) return
		let cancelled = false
		discordUser(id).then(user => {
			if (user.name && !cancelled) setAuthorNames(names => ({ ...names, [id]: user.name! }))
		})
		return () => {
			cancelled = true
		}
	}, [current, epoch])

	React.useEffect(() => {
		if (!current && !detail) return
		const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
			if (detail) setDetail(null)
			else showList()
			return true
		})
		return () => subscription.remove()
	}, [current, detail])

	React.useEffect(() => setLimit(PAGE_SIZE), [query, current, sort])

	const isEnabled = (id: string) => toggled.get(id)?.value ?? state?.enabled[id]?.enabled ?? false
	const addedRepo = (url: string) => state?.repos.find(repo => !repo.internal && slash(repo.url) === slash(url))
	const repoName = (repo: Repo) => listings.get(repo.url)?.name ?? repo.url
	const alertMode = (url: string): AlertMode => data?.alerts?.[url] ?? 'news'

	const pluginName = (id: string) => {
		for (const repo of catalog) {
			const listed = listings.get(repo.url)?.plugins.find(plugin => plugin.id === id)
			if (listed) return listed.name
		}
		return id
	}

	const chooseAlerts = (repo: Repo) => {
		const mode = alertMode(repo.url)
		modal('Notifications', `Choose what ${repoName(repo)} adds to the red count on the settings row.`, Button =>
			(Object.entries(ALERT_MODES) as [AlertMode, (typeof ALERT_MODES)[AlertMode]][]).map(([value, { button }]) =>
				h(Button, { key: value, text: button, variant: value === mode ? 'primary' : 'secondary', onPress: () => setAlertMode(repo.url, value) }),
			),
		)
	}

	const runUpdate = async (ids: string[]) => {
		const list = ids.map(id => available.get(id)).filter((info): info is AvailableUpdate => !!info)
		if (!list.length || updatingIds.length) return
		setUpdatingIds(ids)
		try {
			await updatePlugins(list.map(info => ({ id: info.id, name: pluginName(info.id), installed: info.installed, available: info.available, channel: info.channel })))
		} finally {
			setUpdatingIds([])
		}
	}

	const updateFor = (repo: Repo, plugin: ListedPlugin): CardUpdate | undefined => {
		const info = available.get(plugin.id)
		if (!info || info.repo !== repo.url || !state?.installed.has(plugin.id)) return undefined
		const busy = updatingIds.includes(plugin.id)
		return { from: info.installed, to: info.available, state: pendingReload.has(plugin.id) ? 'pending' : busy ? 'busy' : 'ready', onPress: () => runUpdate([plugin.id]) }
	}

	const needle = query.trim().toLowerCase()
	const matches = (...fields: (string | undefined)[]) => !needle || fields.some(field => typeof field === 'string' && field.toLowerCase().includes(needle))
	const pluginMatches = (plugin: ListedPlugin) => matches(plugin.name, plugin.id, plugin.description, parseAuthor(plugin.author).name)

	const pluginRank = (repo: Repo, plugin: ListedPlugin) => {
		const meta = seen[repo.url]?.meta?.[plugin.id]
		if (sort === 'updated') return meta?.updated ?? 0
		if (sort === 'newest') return meta?.added ?? 0
		if (sort === 'installed') return state?.installed.has(plugin.id) ? 1 : 0
		return 0
	}

	const repoRank = (repo: Repo) => {
		const metas = Object.values(seen[repo.url]?.meta ?? {})
		if (sort === 'updated') return Math.max(0, ...metas.map(meta => Math.max(meta.updated ?? 0, meta.added ?? 0)))
		if (sort === 'newest') return Math.max(0, ...metas.map(meta => meta.added ?? 0))
		if (sort === 'installed') {
			const installedHere = (listings.get(repo.url)?.plugins ?? []).filter(plugin => state?.installed.has(plugin.id)).length
			return installedHere * 2 + (addedRepo(repo.url)?.enabled ? 1 : 0)
		}
		return 0
	}

	const sortPlugins = (hits: Hit[]) =>
		sort === 'default' ? hits : [...hits].sort((a, b) => pluginRank(b.repo, b.plugin) - pluginRank(a.repo, a.plugin) || a.plugin.name.localeCompare(b.plugin.name))

	const installPlugin = async (repo: Repo, plugin: ListedPlugin) => {
		setInstalling(plugin.id)
		await install(repo.url, plugin)
		setInstalling('')
		syncState()
	}

	const removePlugin = (plugin: ListedPlugin) =>
		uninstall(plugin, state ? dependentsOf(plugin.id, state.installed) : []).then(done => {
			if (done) syncState()
		})

	const pluginActions = (repo: Repo, plugin: ListedPlugin, fromSearch: boolean) => {
		if (!state) return []
		const installed = state.installed.get(plugin.id)
		const repoEntry = addedRepo(repo.url)

		if (installed) {
			const on = isEnabled(plugin.id)
			const settingsReady = on && !toggled.has(plugin.id) && !state.enabled[plugin.id]?.pendingReload
			return [
				h(IconButton, {
					key: 'remove',
					size: 'sm',
					variant: 'secondary',
					icon: asset('TrashIcon'),
					onPress: () => removePlugin(plugin),
				}),
				installed.settings &&
					h(IconButton, { key: 'settings', size: 'sm', variant: 'secondary', icon: asset('SettingsIcon'), disabled: !settingsReady, onPress: () => openPluginSettings(plugin.id) }),
				h(FormSwitch, {
					key: 'enabled',
					value: on,
					onValueChange: (value: boolean) => toggle(plugin.id, value).then(done => done && afterToggle(plugin.id, value)),
				}),
			]
		}

		if (repoEntry?.enabled) {
			return [
				h(Button, {
					key: 'install',
					text: 'Install',
					size: 'sm',
					icon: asset('DownloadIcon'),
					loading: installing === plugin.id,
					onPress: () => installPlugin(repo, plugin),
				}),
			]
		}

		return [
			h(Button, {
				key: 'repo',
				text: fromSearch ? 'Open repo' : repoEntry ? 'Enable repo' : 'Add repo',
				size: 'sm',
				variant: 'secondary',
				onPress: () => (fromSearch ? showRepo(repo) : putRepos(slash(repo.url), true).then(syncState).catch(fail)),
			}),
		]
	}

	const pluginCard = (repo: Repo, plugin: ListedPlugin, fromSearch = false) => {
		const version = state?.installed.get(plugin.id)?.version ?? plugin.version
		const origin = fromSearch ? `from ${repoName(repo)}${addedRepo(repo.url)?.enabled ? '' : ' \u2022 repository not added'}` : undefined
		return h(PluginCard, {
			key: `${repo.url}#${plugin.id}`,
			plugin,
			version,
			origin,
			actions: pluginActions(repo, plugin, fromSearch),
			update: updateFor(repo, plugin),
			onPress: () => setDetail({ repo, id: plugin.id }),
		})
	}

	const moreButton = (total: number) =>
		total > limit ? h(Button, { key: 'more', text: `Show more (${total - limit})`, variant: 'secondary', onPress: () => setLimit(count => count + PAGE_SIZE) }) : null

	const controls = () =>
		h(
			View,
			{ key: 'controls', style: { flexDirection: 'row', alignItems: 'center' } },
			h(
				View,
				{ style: { flex: 1 } },
				h(SearchInput, { value: query, onChange: setQuery, isClearable: true, placeholder: current ? 'Search this repository' : 'Search plugins and repositories' }),
			),
			!current &&
				h(
					View,
					{ style: { marginLeft: 8 } },
					h(IconButton, { size: 'md', variant: 'secondary', icon: asset('RetryIcon'), loading: refreshing, disabled: refreshing, onPress: refreshAll }),
				),
			h(
				View,
				{ style: { marginLeft: 8 } },
				h(
					ContextMenu,
					{
						title: 'Sort by',
						items: [
							Object.entries(SORTS).map(([key, label]) => ({
								label,
								IconComponent: key === sort ? () => icon('CheckmarkLargeIcon', 'CheckIcon') : undefined,
								action: () => setSort(key as SortKey),
							})),
						],
					},
					(props: any) => h(IconButton, { ...props, size: 'md', variant: sort !== 'default' ? 'primary' : 'secondary', icon: asset('FiltersHorizontalIcon') }),
				),
			),
		)

	const sortNote = (ranks: number[]) => {
		if (sort === 'default') return null
		const noHistory = (sort === 'updated' || sort === 'newest') && !ranks.some(Boolean)
		return h(
			View,
			{ key: 'sorted', style: { flexDirection: 'row', alignItems: 'center' } },
			h(Text, { variant: 'text-sm/medium', color: 'text-muted', style: { flex: 1 } }, `Sorted by ${SORTS[sort]}${noHistory ? ' (no history yet, showing A-Z)' : ''}`),
			h(Button, { text: 'Reset', size: 'sm', variant: 'tertiary', onPress: () => setSort('default') }),
		)
	}

	const noMatches = () => h(Text, { key: 'none', variant: 'text-md/medium' }, `No plugins match "${query.trim()}".`)

	return {
		seen,
		newRepos,
		current,
		detail,
		setDetail,
		updatingIds,
		authorNames,
		state,
		installing,
		sort,
		setSort,
		limit,
		refreshing,
		retrying,
		reloadingRepo,
		booting,
		epoch,
		needle,
		syncState,
		afterToggle,
		refreshAll,
		refreshCurrent,
		retry,
		showRepo,
		showList,
		isEnabled,
		addedRepo,
		repoName,
		alertMode,
		chooseAlerts,
		runUpdate,
		matches,
		pluginMatches,
		pluginRank,
		repoRank,
		sortPlugins,
		installPlugin,
		removePlugin,
		pluginCard,
		moreButton,
		controls,
		sortNote,
		noMatches,
	}
}

const pluralPlugins = (count: number) => `${count} plugin${count === 1 ? '' : 's'}`

function feed(b: Ctx, kind: 'news' | 'updates', title: string) {
	const { TableRow, TableRowGroup } = Design
	const items = catalog
		.flatMap(repo => Object.entries<any>(b.seen[repo.url]?.[kind] ?? {}).map(([id, value]) => ({ repo, id, value, at: kind === 'news' ? (value as number) : value.at })))
		.filter(item => {
			if (!listings.get(item.repo.url)?.plugins.some(plugin => plugin.id === item.id)) return false
			if (kind === 'news') return true
			return Date.now() - item.at < DAY && !b.seen[item.repo.url].news?.[item.id]
		})
		.sort((a, c) => c.at - a.at)
	if (!items.length) return null

	const rows = items.map(({ repo, id, value, at }) => {
		const listing = listings.get(repo.url)!
		const plugin = listing.plugins.find(item => item.id === id)!
		const note = kind === 'news' ? `New in ${listing.name}` : `Updated in ${listing.name}\n${value.from} to ${value.to}`
		return h(TableRow, {
			key: `${kind}:${repo.url}#${id}`,
			icon: icon(plugin.icon, 'PuzzlePieceIcon'),
			label: plugin.name,
			subLabel: `${note}\n${ago(at)}`,
			subLabelLineClamp: 3,
			arrow: true,
			onPress: () => {
				dismiss(kind, repo.url, id)
				b.showRepo(repo)
			},
		})
	})
	return h(FeedSection, { key: kind, title, onAction: () => dismissAll(kind) }, h(TableRowGroup, null, rows))
}

function updatesSection(b: Ctx) {
	const { TableRow, TableRowGroup } = Design
	const items = [...available.values()].filter(info => b.state?.installed.has(info.id) && !pendingReload.has(info.id) && catalog.some(repo => repo.url === info.repo))
	if (!items.length) return null

	const rows = items.map(info => {
		const repo = catalog.find(item => item.url === info.repo)!
		const listed = listings.get(repo.url)?.plugins.find(plugin => plugin.id === info.id)
		return h(TableRow, {
			key: `update:${info.id}`,
			icon: icon(listed?.icon, 'PuzzlePieceIcon'),
			label: listed?.name ?? info.id,
			subLabel: `${info.installed} to ${info.available}\nfrom ${b.repoName(repo)}`,
			subLabelLineClamp: 2,
			arrow: true,
			onPress: () => b.setDetail({ repo, id: info.id }),
		})
	})

	return h(
		FeedSection,
		{
			key: 'available',
			title: 'Updates available',
			action: 'Update all',
			variant: 'primary',
			loading: b.updatingIds.length > 0,
			onAction: () => b.runUpdate(items.map(info => info.id)),
		},
		h(TableRowGroup, null, rows),
	)
}

function repoRow(b: Ctx, repo: Repo) {
	const { View } = ReactNative
	const { Button, TableRow } = Design
	const listing = listings.get(repo.url)
	const failed = listing?.err || listing?.stale

	let subLabel = 'Loading...'
	if (listing?.err) subLabel = friendlyError(listing.err)
	else if (listing?.stale) subLabel = `Couldn't refresh, showing ${listing.saved ? `copy saved ${ago(listing.saved)}` : 'earlier data'}`
	else if (listing) subLabel = [listing.description, hostOf(repo.url)].filter(Boolean).join('\n')
	if (b.newRepos[repo.url]) subLabel = `New repository\n${subLabel}`

	let trailing
	if (failed) trailing = h(Button, { text: 'Retry', size: 'sm', variant: 'secondary', loading: b.retrying === repo.url, onPress: () => b.retry(repo) })
	else if (listing) trailing = h(TableRow.TrailingText, { text: `Plugins \u00b7 ${listing.plugins.length}` })
	if (repo.badges?.length) trailing = h(View, { style: { alignItems: 'flex-end' } }, h(RepoBadges, { badges: repo.badges }), trailing)

	return h(TableRow, {
		key: repo.url,
		icon: h(RepoAvatar, { repo, listing, epoch: b.epoch }),
		label: b.repoName(repo),
		subLabel,
		labelLineClamp: 1,
		subLabelLineClamp: b.newRepos[repo.url] ? 4 : 3,
		trailing,
		arrow: true,
		onPress: () => {
			dismissRepo(repo.url)
			b.showRepo(repo)
		},
	})
}

function emptyList(b: Ctx) {
	const { Button, Stack, Text } = Design
	const waiting = b.booting || b.refreshing
	return h(
		Stack,
		{ key: 'empty', spacing: 12 },
		h(Text, { variant: 'text-md/medium', color: 'text-muted' }, waiting ? 'Loading repositories...' : "Couldn't load the repository list. Check your connection and try again."),
		!waiting && h(Button, { text: 'Try again', size: 'md', variant: 'secondary', onPress: b.refreshAll }),
	)
}

function MainPage(b: Ctx) {
	const { Stack, TableRowGroup, Text } = Design
	const { needle, sort } = b

	const hits = needle ? b.sortPlugins(catalog.flatMap(repo => (listings.get(repo.url)?.plugins ?? []).filter(b.pluginMatches).map(plugin => ({ repo, plugin })))) : []

	const shown = catalog.filter(repo => b.matches(b.repoName(repo), listings.get(repo.url)?.description, repo.url))
	const isNew = (repo: Repo) => (b.newRepos[repo.url] ? 1 : 0)
	const repos = sort === 'default' ? [...shown].sort((x, y) => isNew(y) - isNew(x)) : shown.sort((x, y) => b.repoRank(y) - b.repoRank(x) || b.repoName(x).localeCompare(b.repoName(y)))

	let results = null
	if (needle && !hits.length) results = b.noMatches()
	else if (needle)
		results = h(
			Stack,
			{ key: 'hits', spacing: 12 },
			h(Text, { variant: 'text-md/semibold', color: 'text-muted' }, `${pluralPlugins(hits.length)} found`),
			...hits.slice(0, b.limit).map(hit => b.pluginCard(hit.repo, hit.plugin, true)),
			b.moreButton(hits.length),
		)

	const ranks = needle ? hits.map(hit => b.pluginRank(hit.repo, hit.plugin)) : repos.map(b.repoRank)

	return [
		b.controls(),
		h(Notice, { key: 'notice' }),
		b.sortNote(ranks),
		results,
		needle ? null : updatesSection(b),
		needle ? null : feed(b, 'news', 'New plugins'),
		needle ? null : feed(b, 'updates', 'Recently updated'),
		catalog.length ? null : emptyList(b),
		repos.length ? h(TableRowGroup, { key: 'all', title: 'Repositories', description: needle ? undefined : `${catalog.length} repositories` }, repos.map(repo => repoRow(b, repo))) : null,
	]
}

function RepoPage(b: Ctx, repo: Repo) {
	const { Stack, TableRow, TableRowGroup, TableSwitchRow, Text } = Design
	const { Linking } = ReactNative
	const listing = listings.get(repo.url)
	const entry = b.addedRepo(repo.url)
	const visible = b.sortPlugins((listing?.plugins ?? []).filter(b.pluginMatches).map(plugin => ({ repo, plugin })))

	let lastUpdated: string | undefined
	if (!b.reloadingRepo) {
		if (listing?.err) lastUpdated = friendlyError(listing.err)
		else if (listing?.at) lastUpdated = `${listing.stale ? 'Last updated' : 'Updated'} ${ago(listing.at)}`
	}

	const header = h(TableRowGroup, { key: 'info', title: listing?.name ?? repo.url, description: [hostOf(repo.url), listing?.description].filter(Boolean).join('\n') }, [
		h(TableRow, { key: 'back', label: 'Back', icon: icon('ArrowLargeLeftIcon'), onPress: b.showList }),
		h(TableRow, {
			key: 'author',
			label: (repo.discord && b.authorNames[repo.discord]) || repoOwner(repo),
			subLabel: 'Author',
			icon: h(RepoAvatar, { repo, listing, epoch: b.epoch, person: true }),
			arrow: !!repo.discord,
			onPress: repo.discord ? () => openUserProfile(repo.discord!) : undefined,
		}),
		entry
			? h(TableSwitchRow, {
					key: 'repo',
					label: entry.enabled ? 'Repository enabled' : 'Repository disabled',
					subLabel: entry.enabled ? 'Added to Revenge' : 'Turn on to install its plugins',
					icon: icon(entry.enabled ? 'CircleCheckIcon' : 'CircleXIcon'),
					value: entry.enabled,
					onValueChange: (value: boolean) => putRepos(entry.url, value).then(b.syncState).catch(fail),
				})
			: h(TableRow, {
					key: 'repo',
					label: 'Add to Revenge',
					subLabel: repo.url,
					icon: icon('DownloadIcon'),
					arrow: true,
					onPress: () => putRepos(slash(repo.url), true).then(b.syncState).catch(fail),
				}),
		h(TableRow, {
			key: 'link',
			label: repo.source ? 'Source' : 'Website',
			subLabel: repo.source ?? repo.url,
			icon: icon(repo.source ? 'PaperIcon' : 'GlobeEarthIcon'),
			arrow: true,
			onPress: () => Linking.openURL(repo.source ?? repo.url),
		}),
		h(TableRow, {
			key: 'alerts',
			label: 'Notifications',
			subLabel: ALERT_MODES[b.alertMode(repo.url)].summary,
			icon: icon('BellIcon'),
			arrow: true,
			onPress: () => b.chooseAlerts(repo),
		}),
		h(TableRow, {
			key: 'refresh',
			label: b.reloadingRepo ? 'Refreshing...' : 'Refresh',
			subLabel: lastUpdated,
			icon: icon('RetryIcon'),
			disabled: b.reloadingRepo,
			onPress: b.refreshCurrent,
		}),
	])

	if (listing?.err) {
		const message = `Failed to load: ${friendlyError(listing.err)}. Use Refresh above to try again.`
		return [header, h(Text, { key: 'err', variant: 'text-md/medium' }, message)]
	}

	return [
		header,
		h(
			Stack,
			{ key: 'plugins', spacing: 12 },
			h(Text, { variant: 'text-md/semibold', color: 'text-muted' }, `This repository comes with ${pluralPlugins(listing?.plugins.length ?? 0)}`),
			!entry?.enabled && h(Text, { key: 'hint', variant: 'text-sm/medium', color: 'text-muted' }, 'Add this repository to Revenge to install its plugins.'),
			b.controls(),
			b.sortNote(visible.map(item => b.pluginRank(item.repo, item.plugin))),
			b.needle && !visible.length && b.noMatches(),
			...visible.slice(0, b.limit).map(item => b.pluginCard(item.repo, item.plugin)),
			b.moreButton(visible.length),
		),
	]
}

function PluginPage(b: Ctx, repo: Repo, id: string) {
	const { TableRow, TableRowGroup, TableSwitchRow, Text } = Design
	const { Linking } = ReactNative
	const listing = listings.get(repo.url)
	const plugin = listing?.plugins.find(item => item.id === id)
	const back = h(TableRow, { key: 'back', label: 'Back', icon: icon('ArrowLargeLeftIcon'), onPress: () => b.setDetail(null) })
	if (!plugin) {
		return [
			h(TableRowGroup, { key: 'head', title: 'Plugin' }, [back]),
			h(Text, { key: 'gone', variant: 'text-md/medium' }, 'This plugin is no longer listed in this repository.'),
		]
	}

	const installed = b.state?.installed.get(id)
	const entry = b.addedRepo(repo.url)
	const info = available.get(id)
	const outdated = !!installed && info?.repo === repo.url && !pendingReload.has(id)
	const on = b.isEnabled(id)
	const settingsReady = on && !toggled.has(id) && !b.state?.enabled[id]?.pendingReload
	const author = parseAuthor(plugin.author)

	const facts = [
		h(TableRow, {
			key: 'version',
			label: 'Version',
			subLabel: installed ? `Installed ${installed.version}${outdated ? `, ${info!.available} available` : ''}` : `Latest ${plugin.version ?? 'unknown'}`,
		}),
		h(TableRow, {
			key: 'author',
			label: 'Author',
			subLabel: author.name,
			arrow: author.ids.length > 0,
			onPress: author.ids.length ? () => openUserProfile(author.ids[0]) : undefined,
		}),
		h(TableRow, {
			key: 'repo',
			label: 'Repository',
			subLabel: `${b.repoName(repo)}\n${hostOf(repo.url)}`,
			icon: h(RepoAvatar, { repo, listing, epoch: b.epoch }),
			arrow: true,
			onPress: () => {
				b.setDetail(null)
				b.showRepo(repo)
			},
		}),
		repo.source && h(TableRow, { key: 'source', label: 'Source', subLabel: repo.source, icon: icon('PaperIcon'), arrow: true, onPress: () => Linking.openURL(repo.source!) }),
		plugin.size && h(TableRow, { key: 'size', label: 'Size', subLabel: formatSize(plugin.size) }),
		plugin.requires?.length ? h(TableRow, { key: 'requires', label: 'Requires', subLabel: plugin.requires.join('\n'), subLabelLineClamp: 6 }) : null,
		h(TableRow, { key: 'id', label: 'Plugin ID', subLabel: id }),
	]

	const actions: any[] = []
	if (installed) {
		if (pendingReload.has(id)) actions.push(h(TableRow, { key: 'updated', label: 'Updated', subLabel: 'Reload to apply it', icon: icon('CircleCheckIcon') }))
		if (outdated)
			actions.push(
				h(TableRow, {
					key: 'update',
					label: b.updatingIds.includes(id) ? 'Updating...' : `Update to ${info!.available}`,
					subLabel: `Installed ${installed.version}`,
					icon: icon('DownloadIcon'),
					arrow: true,
					disabled: b.updatingIds.length > 0,
					onPress: () => b.runUpdate([id]),
				}),
			)
		actions.push(
			h(TableSwitchRow, {
				key: 'enabled',
				label: on ? 'Enabled' : 'Disabled',
				icon: icon('CircleCheckIcon'),
				value: on,
				onValueChange: (value: boolean) => toggle(id, value).then(done => done && b.afterToggle(id, value)),
			}),
		)
		if (installed.settings)
			actions.push(
				h(TableRow, {
					key: 'settings',
					label: 'Settings',
					subLabel: settingsReady ? undefined : 'Enable the plugin and reload to open',
					icon: icon('SettingsIcon'),
					arrow: true,
					disabled: !settingsReady,
					onPress: () => openPluginSettings(id),
				}),
			)
		actions.push(
			h(TableRow, {
				key: 'remove',
				label: 'Uninstall',
				variant: 'danger',
				icon: icon('TrashIcon'),
				onPress: () => b.removePlugin(plugin),
			}),
		)
	} else if (entry?.enabled) {
		actions.push(
			h(TableRow, {
				key: 'install',
				label: b.installing === id ? 'Installing...' : 'Install',
				subLabel: plugin.version ? `Version ${plugin.version}` : undefined,
				icon: icon('DownloadIcon'),
				arrow: true,
				disabled: b.installing === id,
				onPress: () => b.installPlugin(repo, plugin),
			}),
		)
	} else {
		actions.push(
			h(TableRow, {
				key: 'repo',
				label: entry ? 'Enable repository' : 'Add repository',
				subLabel: `${plugin.name} comes from ${b.repoName(repo)}`,
				icon: icon('DownloadIcon'),
				arrow: true,
				onPress: () => putRepos(slash(repo.url), true).then(b.syncState).catch(fail),
			}),
		)
	}

	return [
		h(TableRowGroup, { key: 'head', title: plugin.name, description: plugin.description }, [back]),
		h(TableRowGroup, { key: 'about', title: 'About' }, facts.filter(Boolean)),
		h(TableRowGroup, { key: 'actions', title: 'Actions' }, actions),
	]
}

export function Browser() {
	const { ScrollView } = ReactNative
	const { Stack } = Design
	const b = useBrowser()

	const body = b.detail ? PluginPage(b, b.detail.repo, b.detail.id) : b.current ? RepoPage(b, b.current) : MainPage(b)
	return h(ScrollView, { style: { flex: 1 } }, h(Stack, { spacing: 16, style: { padding: 16 } }, body))
}
