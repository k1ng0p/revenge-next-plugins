type Repo = { url: string; source?: string; discord?: string }

type ListedPlugin = {
	id: string
	name: string
	description?: string
	author?: string
	icon?: string
	version?: string
}

type Listing = {
	name: string
	description?: string
	icon?: string
	plugins: ListedPlugin[]
	at?: number
	saved?: number
	stale?: string
	err?: string
}

type SeenEntry = {
	sig: string
	versions: Record<string, string>
	news: Record<string, number>
	updates: Record<string, { at: number; from: string; to: string }>
	meta: Record<string, { added?: number; updated?: number }>
}

const REPOS: Repo[] = [
	{ url: 'https://k1ng0p.github.io/revenge-next-plugins/', source: 'https://github.com/k1ng0p/revenge-next-plugins', discord: '641266820187160576' },
	{ url: 'https://bleelblep.github.io/revenge-next-plugins/', source: 'https://github.com/bleelblep/revenge-next-plugins', discord: '119043674385547264' },
	{ url: 'https://next.jarviscli.dev/', source: 'https://next.jarviscli.dev/', discord: '1356936317501571214' },
	{ url: 'https://dev-next.jarviscli.dev/', source: 'https://github.com/everestmcarthur/revenge-next-plugs-dev', discord: '1356936317501571214' },
	{ url: 'https://contrabag.github.io/revenge-next-plugins/', source: 'https://github.com/contrabag/revenge-next-plugins', discord: '780075200950566933' },
	{ url: 'https://rn.kmmiio99o.dev/', source: 'https://git.gay/kmmiio99o/revenge-next-plugins', discord: '879393496627306587' },
	{ url: 'https://next.tralwdwd.dev/', source: 'https://github.com/tralwdwd/revenge-next-plugins', discord: '1278723517436788897' },
	{ url: 'https://mxtiy.knifecodez.workers.dev/', source: 'https://github.com/NoReplyUI5/revenge-next-plugins', discord: '1053918356375351386' },
]

const KEY = 'RepositoryBrowser'
const DAY = 24 * 60 * 60 * 1000
const AVATAR_SIZE = 32
const AVATAR_TTL = 10 * 60 * 1000
const POLL_INTERVAL = 15 * 60 * 1000
const RECHECK_AFTER_FOCUS = 5 * 60 * 1000
const MAX_REQUESTS = 4

const SORTS: Record<string, string> = {
	default: 'Default',
	name: 'A-Z',
	updated: 'Recently updated',
	newest: 'Newest',
	installed: 'Installed first',
}

const NOTICE =
	'The repositories listed here are made by the community and are not reviewed by Revenge or Discord. A plugin can access your account and run code inside this app. Only install plugins from authors you trust, read the source before you install, and use them at your own risk.'

const listings = new Map<string, Listing>()
const toggled = new Map<string, boolean>()
let store: any
let lastCheck = 0

const h = (...args: any[]) => (revenge.react.React.createElement as any)(...args)
const native = (name: string, args: any[] = []) => (revenge.modules.native.callNativeMethod as any)(name, args)
const asset = (name?: string) => (name ? revenge.assets.getAssetIdByName(name) : undefined)
const slash = (url: string) => url.replace(/\/*$/, '/')
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))
const isRemote = (value?: string): value is string => !!value && /^(data|https):/.test(value)
const errorMessage = (e: any): string => e?.message ?? String(e)

const ago = (time: number) => {
	const minutes = Math.floor((Date.now() - time) / 60000)
	if (minutes < 1) return 'just now'
	if (minutes < 60) return `${minutes}m ago`
	if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
	return `${Math.floor(minutes / 1440)}d ago`
}

const friendlyError = (err: string) => (/network request failed/i.test(err) ? "Couldn't connect to this repository" : err)

function icon(value?: string, fallback = 'ListViewIcon') {
	if (isRemote(value))
		return h(revenge.react.ReactNative.Image, { source: { uri: value }, style: { width: 24, height: 24, borderRadius: 12 } })
	return h(revenge.discord.design.Design.TableRow.Icon, { source: asset(value) ?? asset(fallback) ?? asset('ic_browse_channel') })
}

// dialogs

function modal(title: string, content: string, actions: (button: any) => any[], onDismiss?: () => void) {
	const { AlertModal, AlertActionButton, Text } = revenge.discord.design.Design
	revenge.discord.actions.AlertActionCreators.openAlert(
		`plugin-browser-${title}`,
		h(AlertModal, {
			title,
			content: h(Text, { color: 'text-default' }, content),
			actions: h(revenge.react.React.Fragment, null, ...actions(AlertActionButton)),
		}),
		onDismiss,
	)
}

const inform = (title: string, text: string) => modal(title, text, Button => [h(Button, { key: 'ok', text: 'OK', variant: 'secondary' })])
const showError = (e: any) => inform('Plugin Browser', errorMessage(e))

const askReload = (text: string) =>
	modal('Reload required', text, Button => [
		h(Button, { key: 'reload', text: 'Reload', variant: 'primary', onPress: () => native('revenge.app.reload') }),
		h(Button, { key: 'later', text: 'Later', variant: 'secondary' }),
	])

const confirm = (title: string, text: string, label = 'Install', variant = 'primary') =>
	new Promise<boolean>(done =>
		modal(
			title,
			text,
			Button => [
				h(Button, { key: 'yes', text: label, variant, onPress: () => done(true) }),
				h(Button, { key: 'no', text: 'Cancel', variant: 'secondary', onPress: () => done(false) }),
			],
			() => done(false),
		),
	)

// avatars

// the image cache keeps old pictures around, so the epoch goes into the url to force a reload
let avatarEpoch = Date.now()
const discordAvatars = new Map<string, { url: string | null; epoch: number }>()

function freshAvatarEpoch(force = false) {
	if (force || Date.now() - avatarEpoch > AVATAR_TTL) avatarEpoch = Date.now()
	return avatarEpoch
}

function githubAvatar(url: string | undefined, epoch: number) {
	const match = url?.match(/^https:\/\/(?:github\.com|([^./]+)\.github\.io)\/([^/]+)/)
	return match ? `https://github.com/${match[1] ?? match[2]}.png?size=96&v=${epoch}` : undefined
}

async function discordAvatar(id: string) {
	const cached = discordAvatars.get(id)
	if (cached?.epoch === avatarEpoch) return cached.url

	let hash: string | null | undefined
	try {
		const { lookupModule, filters } = revenge.modules.finders
		const [http] = lookupModule(filters.withProps('HTTP', 'post'))
		const res = await http.HTTP.get({ url: `/users/${id}` })
		hash = res?.body?.avatar ?? null
	} catch {
		// couldn't ask Discord, fall back to whatever the app already knows
		hash = revenge.discord.flux.Stores.UserStore?.getUser?.(id)?.avatar
		if (!hash) return null
	}

	const url = hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=128` : null
	discordAvatars.set(id, { url, epoch: avatarEpoch })
	return url
}

function RepoAvatar({ repo, listing, epoch }: { repo: Repo; listing?: Listing; epoch: number }) {
	const { React } = revenge.react
	const { Image, View } = revenge.react.ReactNative
	const [discordUrl, setDiscordUrl] = React.useState<string | null>(() => (repo.discord ? (discordAvatars.get(repo.discord)?.url ?? null) : null))
	const [failed, setFailed] = React.useState(0)

	React.useEffect(() => {
		if (!repo.discord) return
		let cancelled = false
		discordAvatar(repo.discord).then(url => {
			if (!cancelled) setDiscordUrl(url)
		})
		return () => {
			cancelled = true
		}
	}, [repo.discord, epoch])

	React.useEffect(() => setFailed(0), [discordUrl, epoch])

	// discord picture first, then the repo's own icon, then the github avatar
	const candidates = [discordUrl, listing?.icon, githubAvatar(repo.source, epoch), githubAvatar(repo.url, epoch)]
		.filter(isRemote)
		.filter((url, index, all) => all.indexOf(url) === index)

	const frame = (child: any) => h(View, { style: { width: AVATAR_SIZE, height: AVATAR_SIZE, alignItems: 'center', justifyContent: 'center' } }, child)

	if (failed >= candidates.length) return frame(icon(isRemote(listing?.icon) ? undefined : listing?.icon))
	return frame(
		h(Image, {
			key: candidates[failed],
			source: { uri: candidates[failed] },
			style: { width: AVATAR_SIZE, height: AVATAR_SIZE, borderRadius: AVATAR_SIZE / 2, backgroundColor: '#4E5058' },
			onError: () => setFailed((count: number) => count + 1),
		}),
	)
}

// loading repositories

const pending = new Map<string, Promise<void>>()
const waiting: (() => void)[] = []
let running = 0

const takeSlot = () => (running < MAX_REQUESTS ? (running++, Promise.resolve()) : new Promise<void>(go => waiting.push(go)))

function freeSlot() {
	const next = waiting.shift()
	if (next) next()
	else running--
}

async function fetchIndex(url: string, attempt: number, timeout: number) {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeout)
	try {
		// the second attempt skips the cache buster in case a host doesn't like query strings
		const query = attempt === 1 ? '' : `?t=${Date.now()}`
		const res = await fetch(`${slash(url)}index.json${query}`, { signal: controller.signal })
		if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { permanent: res.status < 500 && res.status !== 429 })
		const json = await res.json()
		if (typeof json?.plugins !== 'object') throw Object.assign(new Error('Not a Revenge repository'), { permanent: true })
		return json
	} finally {
		clearTimeout(timer)
	}
}

async function fetchRepo(url: string) {
	const deadline = Date.now() + 45000
	let lastError: any
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await fetchIndex(url, attempt, Math.min(15000, deadline - Date.now()))
		} catch (e: any) {
			lastError = e
			if (e?.permanent || Date.now() >= deadline) break
		}
		if (attempt < 2) await sleep(500 * (attempt + 1))
	}
	throw lastError
}

function toListing(json: any): Listing {
	return {
		at: Date.now(),
		name: json.name || '',
		description: json.description,
		icon: json.icon,
		plugins: Object.entries<any>(json.plugins).map(([id, plugin]) => ({
			id,
			name: plugin.name ?? id,
			description: plugin.description,
			author: plugin.author,
			icon: plugin.icon,
			version: plugin.channels?.latest,
		})),
	}
}

function load(url: string) {
	const inProgress = pending.get(url)
	if (inProgress) return inProgress

	const job = takeSlot()
		.then(() => fetchRepo(url))
		.then(json => {
			listings.set(url, { ...toListing(json), name: json.name || url })
		})
		.catch((e: any) => {
			const err = e?.name === 'AbortError' ? 'Request timed out' : errorMessage(e)
			const previous = listings.get(url)
			listings.set(url, previous && !previous.err ? { ...previous, stale: err } : { name: url, plugins: [], err })
		})
		.finally(() => {
			freeSlot()
			pending.delete(url)
		})
	pending.set(url, job)
	return job
}

// tracking new and updated plugins

const save = (patch: Record<string, any>) =>
	store.set({ seen: store.cache?.seen ?? {}, ack: store.cache?.ack ?? 0, snaps: store.cache?.snaps ?? {}, ...patch }, true)

function diffRepo(old: SeenEntry | undefined, listing: Listing): SeenEntry {
	const versions: Record<string, string> = {}
	for (const plugin of listing.plugins) versions[plugin.id] = plugin.version ?? ''
	const sig = JSON.stringify(Object.entries(versions).sort())

	if (!old) return { sig, versions, news: {}, updates: {}, meta: {} }
	if (old.sig === sig) return old

	const now = Date.now()
	const news = { ...old.news }
	const updates = { ...old.updates }
	const meta = { ...old.meta }

	for (const plugin of listing.plugins) {
		const before = old.versions[plugin.id]
		if (before === undefined) {
			news[plugin.id] = now
			meta[plugin.id] = { ...meta[plugin.id], added: now }
		} else if (before !== versions[plugin.id]) {
			updates[plugin.id] = { at: now, from: before, to: versions[plugin.id] }
			meta[plugin.id] = { ...meta[plugin.id], updated: now }
		}
	}

	for (const id of Object.keys(old.versions)) {
		if (id in versions) continue
		delete news[id]
		delete updates[id]
		delete meta[id]
	}

	return { sig, versions, news, updates, meta }
}

async function checkUpdates(only?: string[], onEach?: () => void) {
	const repos = only ? REPOS.filter(repo => only.includes(repo.url)) : REPOS
	await Promise.all(repos.map(repo => load(repo.url).then(onEach)))

	const seen = { ...store.cache?.seen }
	const snaps = { ...store.cache?.snaps }
	for (const repo of repos) {
		const listing = listings.get(repo.url)
		if (!listing || listing.err || listing.stale) continue
		snaps[repo.url] = { at: Date.now(), data: listing }
		seen[repo.url] = diffRepo(seen[repo.url], listing)
	}

	lastCheck = Date.now()
	await save({ seen, snaps })
}

function dismiss(kind: 'news' | 'updates', url: string, id: string) {
	const seen = store.cache?.seen ?? {}
	const entry = seen[url]
	if (!entry?.[kind]?.[id]) return
	const remaining = { ...entry[kind] }
	delete remaining[id]
	return save({ seen: { ...seen, [url]: { ...entry, [kind]: remaining } } })
}

function dismissAll(kind: 'news' | 'updates') {
	const seen = store.cache?.seen ?? {}
	const cleared = Object.fromEntries(Object.entries<any>(seen).map(([url, entry]) => [url, { ...entry, [kind]: {} }]))
	return save({ seen: cleared })
}

function unreadCount(seen: Record<string, SeenEntry>, ack: number) {
	let total = 0
	for (const repo of REPOS) total += Object.values(seen[repo.url]?.news ?? {}).filter(at => at > ack).length
	return total
}

// talking to revenge

const repoList = (): Promise<any[]> => native('revenge.plugins.repos.list')

async function readState() {
	const [repos, plugins, saved] = await Promise.all([repoList(), native('revenge.plugins.list'), native('revenge.plugins.states.read')])
	const installed = new Map<string, { version: string; settings: boolean }>()
	for (const plugin of plugins ?? []) {
		if (plugin.internal) continue
		installed.set(plugin.manifest.id, {
			version: revenge.plugins.utils.formatVersion(plugin.manifest.version),
			settings: !!plugin.script?.includes('SettingsComponent'),
		})
	}
	const enabled: Record<string, { enabled?: boolean; pendingReload?: boolean }> = saved?.states ?? {}
	return { repos: repos as any[], installed, enabled }
}

type RevengeState = Awaited<ReturnType<typeof readState>>

async function putRepos(url: string, enabled: boolean) {
	const list = (await repoList())
		.filter(repo => !repo.internal)
		.map(repo => ({ url: repo.url, enabled: slash(repo.url) === slash(url) ? enabled : repo.enabled }))
	if (!list.some(repo => slash(repo.url) === slash(url))) list.push({ url, enabled })
	await native('revenge.plugins.repos.set', [list])
	await native('revenge.plugins.repos.refresh', [url]).catch(() => {})
}

function openPluginSettings(id: string) {
	const nav = revenge.discord.modules.mainTabsV2.RootNavigationRef.getRootNavigationRef()
	if (nav.isReady()) (nav as any).navigate(id)
}

async function uninstall(plugin: ListedPlugin) {
	if (!(await confirm('Uninstall plugin?', `${plugin.name} and all of its data will be removed. This cannot be undone.`, 'Uninstall', 'destructive'))) return false
	try {
		await native('revenge.plugins.setEnabled', [plugin.id, false]).catch(() => {})
		await native('revenge.plugins.uninstall', [plugin.id])
		askReload('Uninstalled. Reload to apply it.')
		return true
	} catch (e) {
		showError(e)
		return false
	}
}

async function install(repoUrl: string, plugin: ListedPlugin) {
	try {
		const known = (await repoList()).find(repo => slash(repo.url) === slash(repoUrl))
		if (!known?.enabled) await putRepos(repoUrl, true)
		const target = (await repoList()).find(repo => slash(repo.url) === slash(repoUrl))?.url ?? repoUrl

		const plan = await native('revenge.plugins.planInstall', [plugin.id, null, null, [target]])
		const others = plan.actions.filter((action: any) => action.id !== plugin.id).map((action: any) => `${action.id} ${action.version}`)
		const lines = [`${plugin.name} ${plan.actions.find((action: any) => action.id === plugin.id)?.version ?? ''}`]
		if (others.length) lines.push(`Also installs: ${others.join(', ')}`)
		if (plan.warnings.length) lines.push(plan.warnings.join('\n'))
		if (!(await confirm('Install plugin?', lines.join('\n\n')))) return false

		const result = await native('revenge.plugins.install', [plan])
		if (result.pending.length) askReload('Installed. Reload to apply it.')
		return true
	} catch (e) {
		showError(e)
		return false
	}
}

async function toggle(id: string, on: boolean) {
	try {
		const res = await native('revenge.plugins.setEnabled', [id, on])
		if (res?.code) throw new Error(res.problems?.map((p: any) => `${p.id} (${p.required})`).join(', ') ?? res.code)
		askReload(`${on ? 'Enabled' : 'Disabled'}. Reload to apply it.`)
		return true
	} catch (e) {
		showError(e)
		return false
	}
}

// screens

function PluginCard({ plugin, version, origin, actions }: { plugin: ListedPlugin; version?: string; origin?: string; actions: any[] }) {
	const { View } = revenge.react.ReactNative
	const { Card, Text } = revenge.discord.design.Design
	return h(
		Card,
		{ style: { paddingVertical: 12, paddingHorizontal: 12 } },
		h(
			View,
			{ style: { width: '100%' } },
			h(
				View,
				{ style: { flexDirection: 'row', alignItems: 'center', width: '100%' } },
				h(
					View,
					{ style: { flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 } },
					icon(plugin.icon, 'PuzzlePieceIcon'),
					h(Text, { variant: 'heading-lg/semibold', style: { flex: 1, marginLeft: 8 } }, plugin.name),
				),
				h(
					View,
					{ style: { flexDirection: 'row', alignItems: 'center', marginLeft: 8 } },
					...actions.filter(Boolean).map((action, index) => h(View, { key: index, style: { marginLeft: index ? 8 : 0 } }, action)),
				),
			),
			h(
				View,
				{ style: { paddingLeft: 32, marginTop: 6 } },
				h(Text, { color: 'text-muted', variant: 'heading-md/medium' }, `by ${plugin.author ?? 'unknown'}${version ? ` \u2022 ${version}` : ''}`),
				origin && h(Text, { color: 'text-muted', variant: 'text-sm/medium', style: { marginTop: 2 } }, origin),
				h(Text, { variant: 'text-md/medium', style: { marginTop: 4 } }, plugin.description),
			),
		),
	)
}

function Notice() {
	const { View } = revenge.react.ReactNative
	const { Card, IconButton, Text } = revenge.discord.design.Design
	return h(
		Card,
		{ border: 'strong', style: { paddingVertical: 14, paddingHorizontal: 16 } },
		h(
			View,
			{ style: { flexDirection: 'row', alignItems: 'center' } },
			h(
				View,
				{ style: { flex: 1 } },
				h(Text, { variant: 'heading-md/semibold' }, 'Unofficial Plugins and Repositories'),
				h(
					Text,
					{ variant: 'text-sm/medium', color: 'text-muted', style: { marginTop: 4 } },
					'Plugins installed from unofficial sources may run unverified code in this app without your awareness. Check the source first and use at your own risk.',
				),
			),
			h(
				View,
				{ style: { marginLeft: 12 } },
				h(IconButton, {
					size: 'sm',
					variant: 'secondary',
					icon: asset('CircleInformationIcon') ?? asset('InfoIcon'),
					onPress: () => inform('Unofficial sources', NOTICE),
				}),
			),
		),
	)
}

function FeedSection({ title, onClear, children }: { title: string; onClear: () => void; children: any }) {
	const { View } = revenge.react.ReactNative
	const { Button, Text } = revenge.discord.design.Design
	return h(
		View,
		null,
		h(
			View,
			{ style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
			h(Text, { variant: 'text-md/medium', color: 'text-muted' }, title),
			h(Button, { text: 'Clear', size: 'sm', variant: 'tertiary', onPress: onClear }),
		),
		children,
	)
}

function Browser() {
	const { React } = revenge.react
	const { ScrollView, View, BackHandler, Linking } = revenge.react.ReactNative
	const { Stack, TableRow, TableRowGroup, TableSwitchRow, Button, ContextMenu, IconButton, Text } = revenge.discord.design.Design
	const { FormSwitch, SearchInput } = revenge.components

	const seen: Record<string, SeenEntry> = store.use()?.seen ?? {}
	const [current, setCurrent] = React.useState<Repo | null>(null)
	const [state, setState] = React.useState<RevengeState | null>(null)
	const [installing, setInstalling] = React.useState('')
	const [query, setQuery] = React.useState('')
	const [sort, setSort] = React.useState('default')
	const [refreshing, setRefreshing] = React.useState(false)
	const [retrying, setRetrying] = React.useState('')
	const [reloadingRepo, setReloadingRepo] = React.useState(false)
	const [epoch, setEpoch] = React.useState(() => freshAvatarEpoch())
	const [, rerender] = React.useReducer((n: number) => n + 1, 0)

	const syncState = () => readState().then(setState).catch(() => {})

	const refreshAll = async () => {
		if (refreshing) return
		setRefreshing(true)
		setEpoch(freshAvatarEpoch(true))
		await checkUpdates(undefined, rerender)
		await syncState()
		await save({ ack: Date.now() })
		setRefreshing(false)
	}

	const refreshCurrent = async () => {
		if (!current || reloadingRepo) return
		setReloadingRepo(true)
		await checkUpdates([current.url], rerender)
		await syncState()
		setReloadingRepo(false)
	}

	const retry = async (repo: Repo) => {
		setRetrying(repo.url)
		await checkUpdates([repo.url], rerender)
		setRetrying('')
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
		checkUpdates(undefined, () => mounted && rerender()).then(() => {
			if (!mounted) return
			save({ ack: Date.now() })
			rerender()
		})
		return () => {
			mounted = false
		}
	}, [])

	React.useEffect(() => {
		if (!current) return
		const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
			showList()
			return true
		})
		return () => subscription.remove()
	}, [current])

	const isEnabled = (id: string) => toggled.get(id) ?? state?.enabled[id]?.enabled ?? false
	const addedRepo = (url: string) => state?.repos.find(repo => !repo.internal && slash(repo.url) === slash(url))
	const repoName = (repo: Repo) => listings.get(repo.url)?.name ?? repo.url

	const needle = query.trim().toLowerCase()
	const matches = (...fields: any[]) => !needle || fields.some(field => typeof field === 'string' && field.toLowerCase().includes(needle))
	const pluginMatches = (plugin: ListedPlugin) => matches(plugin.name, plugin.id, plugin.description, plugin.author)

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

	type Entry = { repo: Repo; plugin: ListedPlugin }
	const sortPlugins = (entries: Entry[]) =>
		sort === 'default'
			? entries
			: [...entries].sort((a, b) => pluginRank(b.repo, b.plugin) - pluginRank(a.repo, a.plugin) || a.plugin.name.localeCompare(b.plugin.name))

	const pluginActions = (repo: Repo, plugin: ListedPlugin, fromSearch: boolean) => {
		if (!state) return []
		const installed = state.installed.get(plugin.id)
		const repoEntry = addedRepo(repo.url)

		if (installed) {
			const on = isEnabled(plugin.id)
			const settingsReady = on && !toggled.has(plugin.id) && !state.enabled[plugin.id]?.pendingReload
			return [
				h(IconButton, { key: 'remove', size: 'sm', variant: 'secondary', icon: asset('TrashIcon'), onPress: () => uninstall(plugin).then(done => done && syncState()) }),
				installed.settings &&
					h(IconButton, { key: 'settings', size: 'sm', variant: 'secondary', icon: asset('SettingsIcon'), disabled: !settingsReady, onPress: () => openPluginSettings(plugin.id) }),
				h(FormSwitch, {
					key: 'enabled',
					value: on,
					onValueChange: (value: boolean) =>
						toggle(plugin.id, value).then(done => {
							if (!done) return
							toggled.set(plugin.id, value)
							rerender()
						}),
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
					onPress: async () => {
						setInstalling(plugin.id)
						await install(repo.url, plugin)
						setInstalling('')
						syncState()
					},
				}),
			]
		}

		return [
			h(Button, {
				key: 'repo',
				text: fromSearch ? 'Open repo' : repoEntry ? 'Enable repo' : 'Add repo',
				size: 'sm',
				variant: 'secondary',
				onPress: () => (fromSearch ? showRepo(repo) : putRepos(slash(repo.url), true).then(syncState).catch(showError)),
			}),
		]
	}

	const pluginCard = (repo: Repo, plugin: ListedPlugin, fromSearch = false) => {
		const version = state?.installed.get(plugin.id)?.version ?? plugin.version
		const origin = fromSearch ? `from ${repoName(repo)}${addedRepo(repo.url)?.enabled ? '' : ' \u2022 repository not added'}` : undefined
		return h(PluginCard, { key: `${repo.url}#${plugin.id}`, plugin, version, origin, actions: pluginActions(repo, plugin, fromSearch) })
	}

	const controls = () =>
		h(
			View,
			{ key: 'controls', style: { flexDirection: 'row', alignItems: 'center' } },
			h(View, { style: { flex: 1 } }, h(SearchInput, { value: query, onChange: setQuery, isClearable: true, placeholder: current ? 'Search this repository' : 'Search plugins and repositories' })),
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
								action: () => setSort(key),
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

	const feed = (kind: 'news' | 'updates', title: string) => {
		const items = REPOS.flatMap(repo =>
			Object.entries<any>(seen[repo.url]?.[kind] ?? {}).map(([id, value]) => ({ repo, id, value, at: kind === 'news' ? (value as number) : value.at })),
		)
			.filter(item => {
				if (!listings.get(item.repo.url)?.plugins.some(plugin => plugin.id === item.id)) return false
				if (kind === 'news') return true
				return Date.now() - item.at < DAY && !seen[item.repo.url].news?.[item.id]
			})
			.sort((a, b) => b.at - a.at)
		if (!items.length) return null

		const rows = items.map(({ repo, id, value, at }) => {
			const listing = listings.get(repo.url)!
			const plugin = listing.plugins.find(p => p.id === id)!
			const detail = kind === 'news' ? `New in ${listing.name}` : `Updated in ${listing.name}\n${value.from} to ${value.to}`
			return h(TableRow, {
				key: `${kind}:${repo.url}#${id}`,
				icon: icon(plugin.icon, 'PuzzlePieceIcon'),
				label: plugin.name,
				subLabel: `${detail}\n${ago(at)}`,
				subLabelLineClamp: 3,
				arrow: true,
				onPress: () => {
					dismiss(kind, repo.url, id)
					showRepo(repo)
				},
			})
		})
		return h(FeedSection, { key: kind, title, onClear: () => dismissAll(kind) }, h(TableRowGroup, null, rows))
	}

	const noMatches = () => h(Text, { key: 'none', variant: 'text-md/medium' }, `No plugins match "${query.trim()}".`)
	const pluralPlugins = (count: number) => `${count} plugin${count === 1 ? '' : 's'}`

	const repoPage = (repo: Repo) => {
		const listing = listings.get(repo.url)
		const entry = addedRepo(repo.url)
		const visible = sortPlugins((listing?.plugins ?? []).filter(pluginMatches).map(plugin => ({ repo, plugin })))

		let lastUpdated: string | undefined
		if (!reloadingRepo) {
			if (listing?.err) lastUpdated = friendlyError(listing.err)
			else if (listing?.at) lastUpdated = `${listing.stale ? 'Last updated' : 'Updated'} ${ago(listing.at)}`
		}

		const header = h(TableRowGroup, { key: 'info', title: listing?.name ?? repo.url, description: listing?.description }, [
			h(TableRow, { key: 'back', label: 'Back', icon: icon('ArrowLargeLeftIcon'), onPress: showList }),
			entry
				? h(TableSwitchRow, {
						key: 'repo',
						label: entry.enabled ? 'Repository enabled' : 'Repository disabled',
						subLabel: entry.enabled ? 'Added to Revenge' : 'Turn on to install its plugins',
						icon: icon(entry.enabled ? 'CircleCheckIcon' : 'CircleXIcon'),
						value: entry.enabled,
						onValueChange: (value: boolean) => putRepos(entry.url, value).then(syncState),
					})
				: h(TableRow, {
						key: 'repo',
						label: 'Add to Revenge',
						subLabel: repo.url,
						icon: icon('DownloadIcon'),
						arrow: true,
						onPress: () => putRepos(slash(repo.url), true).then(syncState).catch(showError),
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
				key: 'refresh',
				label: reloadingRepo ? 'Refreshing...' : 'Refresh',
				subLabel: lastUpdated,
				icon: icon('RetryIcon'),
				disabled: reloadingRepo,
				onPress: refreshCurrent,
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
				controls(),
				sortNote(visible.map(item => pluginRank(item.repo, item.plugin))),
				needle && !visible.length && noMatches(),
				...visible.map(item => pluginCard(item.repo, item.plugin)),
			),
		]
	}

	const repoRow = (repo: Repo) => {
		const listing = listings.get(repo.url)
		const failed = listing?.err || listing?.stale

		let subLabel = 'Loading...'
		if (listing?.err) subLabel = friendlyError(listing.err)
		else if (listing?.stale) subLabel = `Couldn't refresh, showing ${listing.saved ? `copy saved ${ago(listing.saved)}` : 'earlier data'}`
		else if (listing) subLabel = listing.description || repo.url

		let trailing
		if (failed) trailing = h(Button, { text: 'Retry', size: 'sm', variant: 'secondary', loading: retrying === repo.url, onPress: () => retry(repo) })
		else if (listing) trailing = h(TableRow.TrailingText, { text: `Plugins \u00b7 ${listing.plugins.length}` })

		return h(TableRow, {
			key: repo.url,
			icon: h(RepoAvatar, { repo, listing, epoch }),
			label: repoName(repo),
			subLabel,
			labelLineClamp: 1,
			subLabelLineClamp: 2,
			trailing,
			arrow: true,
			onPress: () => showRepo(repo),
		})
	}

	const mainPage = () => {
		const hits = needle
			? sortPlugins(REPOS.flatMap(repo => (listings.get(repo.url)?.plugins ?? []).filter(pluginMatches).map(plugin => ({ repo, plugin }))))
			: []

		const shown = REPOS.filter(repo => matches(repoName(repo), listings.get(repo.url)?.description, repo.url))
		const repos = sort === 'default' ? shown : shown.sort((a, b) => repoRank(b) - repoRank(a) || repoName(a).localeCompare(repoName(b)))

		let results = null
		if (needle && !hits.length) results = noMatches()
		else if (needle)
			results = h(
				Stack,
				{ key: 'hits', spacing: 12 },
				h(Text, { variant: 'text-md/semibold', color: 'text-muted' }, `${hits.length} plugin${hits.length === 1 ? '' : 's'} found`),
				...hits.map(hit => pluginCard(hit.repo, hit.plugin, true)),
			)

		const ranks = needle ? hits.map(hit => pluginRank(hit.repo, hit.plugin)) : repos.map(repoRank)

		return [
			controls(),
			h(Notice, { key: 'notice' }),
			sortNote(ranks),
			results,
			needle ? null : feed('news', 'New plugins'),
			needle ? null : feed('updates', 'Recently updated'),
			repos.length
				? h(TableRowGroup, { key: 'all', title: 'Repositories', description: needle ? undefined : `${REPOS.length} repositories` }, repos.map(repoRow))
				: null,
		]
	}

	const body = current ? repoPage(current) : mainPage()
	return h(ScrollView, { style: { flex: 1 } }, h(Stack, { spacing: 16, style: { padding: 16 } }, body))
}

function RepoCount() {
	const { View } = revenge.react.ReactNative
	const { Text } = revenge.discord.design.Design
	const data = store.use()
	const unread = unreadCount(data?.seen ?? {}, data?.ack ?? 0)
	return h(
		View,
		{ style: { flexDirection: 'row', alignItems: 'center' } },
		unread > 0 &&
			h(
				View,
				{ style: { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, marginRight: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F23F42' } },
				h(Text, { variant: 'text-xs/bold', style: { color: '#FFFFFF' } }, unread > 99 ? '99+' : String(unread)),
			),
		h(Text, { variant: 'text-md/medium', color: 'text-muted' }, String(REPOS.length)),
	)
}

export default plugin({
	jsonStorage: { load: true, default: { seen: {}, ack: 0, snaps: {} } },
	SettingsComponent: Browser,
	start({ cleanup, plugin, jsonStorage }) {
		if (plugin.startedLate) plugin.requireReload()
		store = jsonStorage

		for (const [url, snap] of Object.entries<any>(jsonStorage.cache?.snaps ?? {}))
			if (REPOS.some(repo => repo.url === url)) listings.set(url, { ...snap.data, saved: snap.at })

		const settings = revenge.discord.modules.settings
		const undo: (() => void)[] = []
		let retry: any
		let attempts = 0
		let stopped = false

		const poll = () => checkUpdates().catch(() => {})
		poll().then(() => settings.refreshSettings())

		// keep looking for new plugins while the app stays open
		const interval = setInterval(poll, POLL_INTERVAL)
		const appState = revenge.react.ReactNative.AppState.addEventListener('change', (next: string) => {
			if (next === 'active' && Date.now() - lastCheck > RECHECK_AFTER_FOCUS) poll()
		})

		const revengeSectionExists = () => {
			try {
				settings.addSettingsItemToSection('REVENGE', items => items)()
				return true
			} catch {
				return false
			}
		}

		// sections are placed in the order they were registered, so ours has to come after Revenge's own
		// or it ends up far down the list. Revenge registers it a moment after the settings modules load,
		// so check a few times in a row before falling back to a timer.
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
	},
})
