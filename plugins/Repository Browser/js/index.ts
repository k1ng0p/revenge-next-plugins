// the list of repositories lives in this file, change it on GitHub without a plugin update
const REMOTE_LIST = 'https://raw.githubusercontent.com/k1ng0p/revenge-next-plugins/refs/heads/main/plugins/Repository%20Browser/js/plugin-browser-repos.json'

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

const ALERT_MODES: [AlertMode, string][] = [
	['all', 'New plugins and updates'],
	['news', 'New plugins only'],
	['updates', 'Updates to my plugins'],
	['off', 'Off'],
]

const ALERT_LABELS: Record<AlertMode, string> = {
	all: 'New plugins and updates to your plugins',
	news: 'New plugins only',
	updates: 'Only updates to your plugins',
	off: 'Off',
}

const NOTICE =
	'The repositories listed here are made by the community and are not reviewed by Revenge or Discord. A plugin can access your account and run code inside this app. Only install plugins from authors you trust, read the source before you install, and use them at your own risk.'

type Repo = { url: string; source?: string; discord?: string }

type ListedPlugin = {
	id: string
	name: string
	description?: string
	author?: string
	icon?: string
	version?: string
	size?: number
	requires?: string[]
}

type AlertMode = 'all' | 'news' | 'updates' | 'off'

type AvailableUpdate = { id: string; installed: string; available: string; channel: string; repo: string }

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

let catalog: Repo[] = []
const listings = new Map<string, Listing>()
const toggled = new Map<string, boolean>()
const available = new Map<string, AvailableUpdate>()
const pendingReload = new Set<string>()
let store: any
let lastCheck = 0

const h = (...args: any[]) => (revenge.react.React.createElement as any)(...args)
// newer Revenge wraps replies as { result } or { error }, older builds return the value itself
let wrapped = false

async function native(name: string, args: any[] = []) {
	const reply = await (revenge.modules.native.callNativeMethod as any)(name, args)
	const keys = reply && typeof reply === 'object' && !Array.isArray(reply) ? Object.keys(reply) : []
	if (keys.length === 1 && keys[0] === 'result') {
		wrapped = true
		return reply.result
	}
	if (keys.length === 1 && keys[0] === 'error') {
		wrapped = true
		throw Object.assign(new Error(reply.error?.message ?? reply.error?.code ?? 'Unknown error'), { code: reply.error?.code, details: reply.error?.details })
	}
	return reply
}

const asObject = (value: any): Record<string, any> => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
const warningMessages = (plan: any): string[] =>
	(plan?.warnings ?? [])
		.filter((warning: any) => warning?.type !== 'upToDate')
		.map((warning: any) => (typeof warning === 'string' ? warning : warning?.message))
		.filter(Boolean)
const asset = (name?: string) => (name ? revenge.assets.getAssetIdByName(name) : undefined)
const slash = (url: string) => url.replace(/\/*$/, '/')
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))
const isRemote = (value?: string): value is string => !!value && /^(data|https):/.test(value)
const errorMessage = (e: any): string => e?.message ?? String(e)
const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

const ago = (time: number) => {
	const minutes = Math.floor((Date.now() - time) / 60000)
	if (minutes < 1) return 'just now'
	if (minutes < 60) return `${minutes}m ago`
	if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
	return `${Math.floor(minutes / 1440)}d ago`
}

const friendlyError = (err: string) => (/network request failed/i.test(err) ? "Couldn't connect to this repository" : err)

function icon(value?: string, fallback = 'ListViewIcon') {
	if (isRemote(value)) return h(revenge.react.ReactNative.Image, { source: { uri: value }, style: { width: 24, height: 24, borderRadius: 12 } })
	return h(revenge.discord.design.Design.TableRow.Icon, { source: asset(value) ?? asset(fallback) ?? asset('ic_browse_channel') })
}

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

// the epoch goes into image urls so changed pictures don't come from the image cache
let avatarEpoch = Date.now()
const discordUsers = new Map<string, { avatar: string | null; name: string | null; epoch: number }>()

function freshAvatarEpoch(force = false) {
	if (force || Date.now() - avatarEpoch > AVATAR_TTL) avatarEpoch = Date.now()
	return avatarEpoch
}

function githubAvatar(url: string | undefined, epoch: number) {
	const match = url?.match(/^https:\/\/(?:github\.com|([^./]+)\.github\.io)\/([^/]+)/)
	return match ? `https://github.com/${match[1] ?? match[2]}.png?size=96&v=${epoch}` : undefined
}

function knownUser(id: string) {
	try {
		return revenge.discord.flux.Stores.UserStore?.getUser?.(id)
	} catch {
		return undefined
	}
}

async function discordUser(id: string) {
	const cached = discordUsers.get(id)
	if (cached?.epoch === avatarEpoch) return cached

	let hash: string | null | undefined
	let name: string | null | undefined
	try {
		const { lookupModule, filters } = revenge.modules.finders
		const [http] = lookupModule(filters.withProps('HTTP', 'post'))
		const body = (await http.HTTP.get({ url: `/users/${id}` }))?.body
		hash = body?.avatar ?? null
		name = body?.global_name ?? body?.username
	} catch {
		const user = knownUser(id)
		if (!user?.avatar && !user?.username) return { avatar: null, name: null, epoch: avatarEpoch }
		hash = user.avatar
		name = user.globalName ?? user.username
	}

	const avatar = hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=128` : null
	const found = { avatar, name: name ?? null, epoch: avatarEpoch }
	discordUsers.set(id, found)
	return found
}

function repoOwner(repo: Repo) {
	const address = repo.source ?? repo.url
	const match = address.match(/^https:\/\/(?:github\.com\/([^/]+)|([^./]+)\.github\.io)/)
	return match ? (match[1] ?? match[2]) : (address.match(/^https:\/\/([^/]+)/)?.[1] ?? address)
}

function RepoAvatar({ repo, listing, epoch, person }: { repo: Repo; listing?: Listing; epoch: number; person?: boolean }) {
	const { React } = revenge.react
	const { Image, View } = revenge.react.ReactNative
	const [discordUrl, setDiscordUrl] = React.useState<string | null>(() => (repo.discord ? (discordUsers.get(repo.discord)?.avatar ?? null) : null))
	const [failed, setFailed] = React.useState(0)

	React.useEffect(() => {
		if (!repo.discord) return
		let cancelled = false
		discordUser(repo.discord).then(user => {
			if (!cancelled) setDiscordUrl(user.avatar)
		})
		return () => {
			cancelled = true
		}
	}, [repo.discord, epoch])

	React.useEffect(() => setFailed(0), [discordUrl, epoch])

	const candidates = [discordUrl, person ? undefined : listing?.icon, githubAvatar(repo.source, epoch), githubAvatar(repo.url, epoch)]
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
		// second attempt goes without ?t= in case the host dislikes query strings
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
		plugins: Object.entries<any>(json.plugins).map(([id, plugin]) => {
			const version = plugin.channels?.latest
			const build = plugin.versions?.[version]
			return {
				id,
				name: plugin.name ?? id,
				description: plugin.description,
				author: plugin.author,
				icon: plugin.icon,
				version,
				size: build?.size,
				requires: Object.entries<any>(build?.dependencies ?? {}).map(([dep, info]) => `${dep} ${info.version}${info.optional ? ' (optional)' : ''}`),
			}
		}),
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

const save = (patch: Record<string, any>) =>
	store.set(
		{
			seen: store.cache?.seen ?? {},
			ack: store.cache?.ack ?? 0,
			snaps: store.cache?.snaps ?? {},
			remote: store.cache?.remote ?? null,
			known: store.cache?.known ?? null,
			newRepos: store.cache?.newRepos ?? {},
			updatesSeen: store.cache?.updatesSeen ?? null,
			alerts: store.cache?.alerts ?? {},
			...patch,
		},
		true,
	)

function parseRepoList(json: any): Repo[] | null {
	const items = Array.isArray(json) ? json : json?.repos
	if (!Array.isArray(items)) return null

	const repos: Repo[] = []
	for (const item of items) {
		const url = typeof item?.url === 'string' ? item.url.trim() : ''
		if (!/^https:\/\/[^\s/]+/.test(url) || repos.some(repo => slash(repo.url) === slash(url))) continue

		const repo: Repo = { url: slash(url) }
		if (typeof item.source === 'string' && /^https:\/\//.test(item.source.trim())) repo.source = item.source.trim()
		if (typeof item.discord === 'string' && /^\d{15,25}$/.test(item.discord.trim())) repo.discord = item.discord.trim()
		repos.push(repo)
	}
	return repos.length ? repos : null
}

async function fetchRepoList() {
	for (let attempt = 0; attempt < 2; attempt++) {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), 10000)
		try {
			const res = await fetch(`${REMOTE_LIST}?t=${Date.now()}`, { signal: controller.signal })
			if (res.ok) return parseRepoList(await res.json())
			if (res.status < 500) return null
		} catch {
			// try again
		} finally {
			clearTimeout(timer)
		}
		if (attempt === 0) await sleep(800)
	}
	return null
}

async function refreshCatalog() {
	const next = await fetchRepoList()
	if (!next) return false

	const first = !store.cache?.known
	const known = new Set<string>(store.cache?.known ?? next.map(repo => repo.url))
	const newRepos: Record<string, number> = { ...store.cache?.newRepos }
	let added = false
	if (!first) {
		for (const repo of next) {
			if (known.has(repo.url)) continue
			known.add(repo.url)
			newRepos[repo.url] = Date.now()
			added = true
		}
	}

	const changed = JSON.stringify(next) !== JSON.stringify(catalog)
	if (!changed && !first && !added) return false

	const urls = new Set(next.map(repo => repo.url))
	const keep = (all: Record<string, any>) => Object.fromEntries(Object.entries(all).filter(([url]) => urls.has(url)))
	for (const url of Object.keys(newRepos)) if (!urls.has(url)) delete newRepos[url]

	catalog = next
	await save({
		remote: { repos: next },
		known: [...known],
		newRepos,
		seen: keep(store.cache?.seen ?? {}),
		snaps: keep(store.cache?.snaps ?? {}),
	})
	return changed
}

type SeenEntry = {
	sig: string
	versions: Record<string, string>
	news: Record<string, number>
	updates: Record<string, { at: number; from: string; to: string }>
	meta: Record<string, { added?: number; updated?: number }>
}

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
	const inScope = (repo: Repo) => !only || only.includes(repo.url)
	const loadAll = (list: Repo[]) => Promise.all(list.map(repo => load(repo.url).then(onEach)))

	const listJob = only ? Promise.resolve(false) : refreshCatalog()
	await loadAll(catalog.filter(inScope))
	await listJob
	await loadAll(catalog.filter(repo => inScope(repo) && !listings.has(repo.url)))
	const repos = catalog.filter(inScope)

	const seen = { ...store.cache?.seen }
	const snaps = { ...store.cache?.snaps }
	for (const repo of repos) {
		const listing = listings.get(repo.url)
		if (!listing || listing.err || listing.stale) continue
		snaps[repo.url] = { at: Date.now(), data: listing }
		seen[repo.url] = diffRepo(seen[repo.url], listing)
	}

	const updatesSeen = only ? null : await refreshAvailable().catch(() => null)
	lastCheck = Date.now()
	await save(updatesSeen ? { seen, snaps, updatesSeen } : { seen, snaps })
}

async function refreshAvailable() {
	const added: any[] = await repoList().catch(() => [])
	const found: AvailableUpdate[] = []
	const checked = new Set<string>()

	const active = catalog.filter(repo => added.some(item => !item.internal && item.enabled && slash(item.url) === slash(repo.url)))
	// revenge plans updates from its own cached index, so refresh that first
	await Promise.all(active.map(repo => native('revenge.plugins.repos.refresh', [repo.url]).catch(() => {})))

	if (wrapped) {
		try {
			const updates: any[] = (await native('revenge.plugins.listUpdates')) ?? []
			for (const repo of active) {
				checked.add(repo.url)
				for (const update of updates) if (!update.blocker && slash(update.repo ?? '') === slash(repo.url)) found.push({ ...update, repo: repo.url })
			}
		} catch {
			// not indexed yet
		}
	} else {
		await Promise.all(
			active.map(async repo => {
				try {
					for (const update of (await native('revenge.plugins.repos.listUpdates', [repo.url])) ?? []) found.push({ ...update, repo: repo.url })
					checked.add(repo.url)
				} catch {
					// not indexed yet
				}
			}),
		)
	}

	for (const [id, info] of available) if (checked.has(info.repo) || !catalog.some(repo => repo.url === info.repo)) available.delete(id)
	for (const info of found) available.set(info.id, info)

	const first = !store.cache?.updatesSeen
	const updatesSeen: Record<string, Record<string, number>> = { ...store.cache?.updatesSeen }
	for (const url of checked) {
		const bucket: Record<string, number> = {}
		for (const info of available.values()) {
			if (info.repo !== url) continue
			const key = `${info.id}@${info.available}`
			bucket[key] = updatesSeen[url]?.[key] ?? (first ? 0 : Date.now())
		}
		updatesSeen[url] = bucket
	}
	return updatesSeen
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

function unreadCount(data: any) {
	const seen = asObject(data?.seen)
	const alerts = asObject(data?.alerts)
	const updatesSeen = asObject(data?.updatesSeen)
	const ack = typeof data?.ack === 'number' ? data.ack : 0
	let total = 0
	for (const repo of catalog) {
		const mode: AlertMode = alerts[repo.url] ?? 'news'
		if (mode === 'all' || mode === 'news') total += Object.values<number>(asObject(seen[repo.url]?.news)).filter(at => at > ack).length
		if (mode === 'all' || mode === 'updates') total += Object.values<number>(asObject(updatesSeen[repo.url])).filter(at => at > ack).length
	}
	return total
}

const setAlertMode = (url: string, mode: AlertMode) => save({ alerts: { ...asObject(store.cache?.alerts), [url]: mode } })

function newRepoCount(data: any) {
	const ack = typeof data?.ack === 'number' ? data.ack : 0
	return Object.entries<number>(asObject(data?.newRepos)).filter(([url, at]) => at > ack && catalog.some(repo => repo.url === url)).length
}

function repairStore() {
	const stored = asObject(store.cache)
	return save({
		seen: asObject(stored.seen),
		snaps: asObject(stored.snaps),
		newRepos: asObject(stored.newRepos),
		alerts: asObject(stored.alerts),
		updatesSeen: stored.updatesSeen && typeof stored.updatesSeen === 'object' ? stored.updatesSeen : null,
		known: Array.isArray(stored.known) ? stored.known : null,
		ack: typeof stored.ack === 'number' ? stored.ack : 0,
	})
}

function dismissRepo(url: string) {
	const newRepos = { ...asObject(store.cache?.newRepos) }
	if (!newRepos[url]) return
	delete newRepos[url]
	return save({ newRepos })
}

const repoList = (): Promise<any[]> => native('revenge.plugins.repos.list')

async function readState() {
	const [repos, plugins, saved, slots] = await Promise.all([
		repoList(),
		native('revenge.plugins.list'),
		native('revenge.plugins.states.read'),
		wrapped ? native('revenge.plugins.states.getSlots').catch(() => null) : null,
	])
	const installed = new Map<string, { version: string; settings: boolean }>()
	for (const plugin of plugins ?? []) {
		if (plugin.internal) continue
		installed.set(plugin.manifest.id, {
			version: revenge.plugins.utils.formatVersion(plugin.manifest.version),
			settings: !!plugin.script?.includes('SettingsComponent'),
		})
	}
	// newer builds keep one set of states per slot
	const enabled: Record<string, { enabled?: boolean; pendingReload?: boolean }> = wrapped ? (asObject(saved)[slots?.active] ?? {}) : (saved?.states ?? {})
	return { repos: (repos ?? []) as any[], installed, enabled }
}

type RevengeState = Awaited<ReturnType<typeof readState>>

async function putRepos(url: string, enabled: boolean) {
	const list = (await repoList()).filter(repo => !repo.internal).map(repo => ({ url: repo.url, enabled: slash(repo.url) === slash(url) ? enabled : repo.enabled }))
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
		await native('revenge.plugins.setEnabled', [plugin.id, false, false]).catch(() => {})
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

		const plan = await native('revenge.plugins.planInstall', wrapped ? [plugin.id, { repos: [target] }] : [plugin.id, null, null, [target]])
		const others = plan.actions.filter((action: any) => action.id !== plugin.id).map((action: any) => `${action.id} ${action.version}`)
		const lines = [`${plugin.name} ${plan.actions.find((action: any) => action.id === plugin.id)?.version ?? ''}`]
		if (others.length) lines.push(`Also installs: ${others.join(', ')}`)
		if (warningMessages(plan).length) lines.push(warningMessages(plan).join('\n'))
		if (!(await confirm('Install plugin?', lines.join('\n\n')))) return false

		const result = await native('revenge.plugins.install', [plan])
		if (result.pending.length) askReload('Installed. Reload to apply it.')
		return true
	} catch (e) {
		showError(e)
		return false
	}
}

type PendingUpdate = { id: string; name: string; installed: string; available: string; channel: string }

async function updatePlugins(updates: PendingUpdate[]) {
	try {
		const plans = []
		for (const update of updates)
			plans.push(await native('revenge.plugins.planInstall', wrapped ? [update.id, { skipMissingOptionals: true }] : [update.id, null, update.channel, null]))

		const lines = updates.map(update => `${update.name} ${update.installed} to ${update.available}`)
		const warnings = plans.flatMap(warningMessages)
		if (warnings.length) lines.push(warnings.join('\n'))
		const title = updates.length === 1 ? 'Update plugin?' : `Update ${updates.length} plugins?`
		if (!(await confirm(title, lines.join('\n'), 'Update'))) return false

		for (const plan of plans) await native('revenge.plugins.install', [plan])
		for (const update of updates) pendingReload.add(update.id)
		askReload('Updated. Reload to apply it.')
		return true
	} catch (e) {
		showError(e)
		return false
	}
}

async function writeEnabled(id: string, on: boolean) {
	const res = await native('revenge.plugins.setEnabled', [id, on, on])
	// older builds answer with the problem instead of rejecting
	if (res?.code)
		throw Object.assign(new Error(res.problems?.map((p: any) => `${p.id} (${p.required})`).join(', ') ?? res.code), { code: res.code, details: { problems: res.problems } })
}

async function toggle(id: string, on: boolean) {
	try {
		try {
			await writeEnabled(id, on)
		} catch (e: any) {
			const disabled = on ? (e?.details?.problems ?? []).filter((problem: any) => problem.installed && !problem.enabled) : []
			if (!disabled.length) throw e
			for (const dependency of disabled) await native('revenge.plugins.setEnabled', [dependency.id, true, false])
			await writeEnabled(id, on)
		}
		askReload(`${on ? 'Enabled' : 'Disabled'}. Reload to apply it.`)
		return true
	} catch (e) {
		showError(e)
		return false
	}
}

type CardUpdate = { from: string; to: string; state: 'ready' | 'busy' | 'pending'; onPress: () => void }

function PluginCard(props: { plugin: ListedPlugin; version?: string; origin?: string; actions: any[]; update?: CardUpdate; onPress?: () => void }) {
	const { plugin, version, origin, actions, update, onPress } = props
	const { Pressable, View } = revenge.react.ReactNative
	const { Button, Card, Text } = revenge.discord.design.Design
	return h(
		Pressable,
		{ onPress },
		h(
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
					update &&
						h(
							View,
							{ style: { flexDirection: 'row', alignItems: 'center', marginTop: 8 } },
							h(
								Text,
								{ variant: 'text-sm/semibold', color: update.state === 'pending' ? 'text-muted' : 'text-link', style: { flex: 1 } },
								update.state === 'pending' ? 'Updated, reload to apply it' : `Update available: ${update.from} to ${update.to}`,
							),
							update.state !== 'pending' && h(Button, { text: 'Update', size: 'sm', icon: asset('DownloadIcon'), loading: update.state === 'busy', onPress: update.onPress }),
						),
				),
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

function FeedSection(props: { title: string; action?: string; variant?: string; loading?: boolean; onAction: () => void; children: any }) {
	const { title, action = 'Clear', variant = 'tertiary', loading, onAction, children } = props
	const { View } = revenge.react.ReactNative
	const { Button, Text } = revenge.discord.design.Design
	return h(
		View,
		null,
		h(
			View,
			{ style: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
			h(Text, { variant: 'text-md/medium', color: 'text-muted' }, title),
			h(Button, { text: action, size: 'sm', variant, loading, onPress: onAction }),
		),
		children,
	)
}

function Browser() {
	const { React } = revenge.react
	const { ScrollView, View, BackHandler, Linking } = revenge.react.ReactNative
	const { Stack, TableRow, TableRowGroup, TableSwitchRow, Button, ContextMenu, IconButton, Text } = revenge.discord.design.Design
	const { FormSwitch, SearchInput } = revenge.components

	const data = store.use()
	const seen: Record<string, SeenEntry> = data?.seen ?? {}
	const newRepos: Record<string, number> = data?.newRepos ?? {}
	const [current, setCurrent] = React.useState<Repo | null>(null)
	const [detail, setDetail] = React.useState<{ repo: Repo; id: string } | null>(null)
	const [updatingIds, setUpdatingIds] = React.useState<string[]>([])
	const [authorNames, setAuthorNames] = React.useState<Record<string, string>>({})
	const [state, setState] = React.useState<RevengeState | null>(null)
	const [installing, setInstalling] = React.useState('')
	const [query, setQuery] = React.useState('')
	const [sort, setSort] = React.useState('default')
	const [refreshing, setRefreshing] = React.useState(false)
	const [retrying, setRetrying] = React.useState('')
	const [reloadingRepo, setReloadingRepo] = React.useState(false)
	const [booting, setBooting] = React.useState(true)
	const [epoch, setEpoch] = React.useState(() => freshAvatarEpoch())
	const [, rerender] = React.useReducer((n: number) => n + 1, 0)

	const syncState = () =>
		readState()
			.then(setState)
			.catch(() => {})

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

	const showPlugin = (repo: Repo, id: string) => setDetail({ repo, id })

	React.useEffect(() => {
		let mounted = true
		save({ ack: Date.now() })
		syncState()
		checkUpdates(undefined, () => mounted && rerender()).then(() => {
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

	const isEnabled = (id: string) => toggled.get(id) ?? state?.enabled[id]?.enabled ?? false
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
			ALERT_MODES.map(([value, label]) => h(Button, { key: value, text: label, variant: value === mode ? 'primary' : 'secondary', onPress: () => setAlertMode(repo.url, value) })),
		)
	}

	const runUpdate = async (ids: string[]) => {
		const list = ids.map(id => available.get(id)).filter((info): info is AvailableUpdate => !!info)
		if (!list.length || updatingIds.length) return
		setUpdatingIds(ids)
		await updatePlugins(list.map(info => ({ id: info.id, name: pluginName(info.id), installed: info.installed, available: info.available, channel: info.channel })))
		setUpdatingIds([])
	}

	const updateFor = (repo: Repo, plugin: ListedPlugin): CardUpdate | undefined => {
		const info = available.get(plugin.id)
		if (!info || info.repo !== repo.url || !state?.installed.has(plugin.id)) return undefined
		const busy = updatingIds.includes(plugin.id)
		return { from: info.installed, to: info.available, state: pendingReload.has(plugin.id) ? 'pending' : busy ? 'busy' : 'ready', onPress: () => runUpdate([plugin.id]) }
	}

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
		sort === 'default' ? entries : [...entries].sort((a, b) => pluginRank(b.repo, b.plugin) - pluginRank(a.repo, a.plugin) || a.plugin.name.localeCompare(b.plugin.name))

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
		return h(PluginCard, {
			key: `${repo.url}#${plugin.id}`,
			plugin,
			version,
			origin,
			actions: pluginActions(repo, plugin, fromSearch),
			update: updateFor(repo, plugin),
			onPress: () => showPlugin(repo, plugin.id),
		})
	}

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
		const items = catalog
			.flatMap(repo => Object.entries<any>(seen[repo.url]?.[kind] ?? {}).map(([id, value]) => ({ repo, id, value, at: kind === 'news' ? (value as number) : value.at })))
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
		return h(FeedSection, { key: kind, title, onAction: () => dismissAll(kind) }, h(TableRowGroup, null, rows))
	}

	const updatesSection = () => {
		const items = [...available.values()].filter(info => state?.installed.has(info.id) && !pendingReload.has(info.id) && catalog.some(repo => repo.url === info.repo))
		if (!items.length) return null

		const rows = items.map(info => {
			const repo = catalog.find(item => item.url === info.repo)!
			const listed = listings.get(repo.url)?.plugins.find(plugin => plugin.id === info.id)
			return h(TableRow, {
				key: `update:${info.id}`,
				icon: icon(listed?.icon, 'PuzzlePieceIcon'),
				label: listed?.name ?? info.id,
				subLabel: `${info.installed} to ${info.available}\nfrom ${repoName(repo)}`,
				subLabelLineClamp: 2,
				arrow: true,
				onPress: () => showPlugin(repo, info.id),
			})
		})

		return h(
			FeedSection,
			{
				key: 'available',
				title: 'Updates available',
				action: 'Update all',
				variant: 'primary',
				loading: updatingIds.length > 0,
				onAction: () => runUpdate(items.map(info => info.id)),
			},
			h(TableRowGroup, null, rows),
		)
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
			h(TableRow, {
				key: 'author',
				label: (repo.discord && authorNames[repo.discord]) || repoOwner(repo),
				subLabel: 'Author',
				icon: h(RepoAvatar, { repo, listing, epoch, person: true }),
				arrow: !!repo.discord,
				onPress: repo.discord ? () => Linking.openURL(`https://discord.com/users/${repo.discord}`) : undefined,
			}),
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
				key: 'alerts',
				label: 'Notifications',
				subLabel: ALERT_LABELS[alertMode(repo.url)],
				icon: icon('BellIcon'),
				arrow: true,
				onPress: () => chooseAlerts(repo),
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

	const pluginPage = (repo: Repo, id: string) => {
		const listing = listings.get(repo.url)
		const plugin = listing?.plugins.find(item => item.id === id)
		const back = h(TableRow, { key: 'back', label: 'Back', icon: icon('ArrowLargeLeftIcon'), onPress: () => setDetail(null) })
		if (!plugin) {
			return [
				h(TableRowGroup, { key: 'head', title: 'Plugin' }, [back]),
				h(Text, { key: 'gone', variant: 'text-md/medium' }, 'This plugin is no longer listed in this repository.'),
			]
		}

		const installed = state?.installed.get(id)
		const entry = addedRepo(repo.url)
		const info = available.get(id)
		const outdated = !!installed && info?.repo === repo.url && !pendingReload.has(id)
		const on = isEnabled(id)
		const settingsReady = on && !toggled.has(id) && !state?.enabled[id]?.pendingReload

		const facts = [
			h(TableRow, {
				key: 'version',
				label: 'Version',
				subLabel: installed ? `Installed ${installed.version}${outdated ? `, ${info!.available} available` : ''}` : `Latest ${plugin.version ?? 'unknown'}`,
			}),
			h(TableRow, { key: 'author', label: 'Author', subLabel: plugin.author ?? 'unknown' }),
			h(TableRow, {
				key: 'repo',
				label: 'Repository',
				subLabel: repoName(repo),
				icon: h(RepoAvatar, { repo, listing, epoch }),
				arrow: true,
				onPress: () => {
					setDetail(null)
					showRepo(repo)
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
						label: updatingIds.includes(id) ? 'Updating...' : `Update to ${info!.available}`,
						subLabel: `Installed ${installed.version}`,
						icon: icon('DownloadIcon'),
						arrow: true,
						disabled: updatingIds.length > 0,
						onPress: () => runUpdate([id]),
					}),
				)
			actions.push(
				h(TableSwitchRow, {
					key: 'enabled',
					label: on ? 'Enabled' : 'Disabled',
					icon: icon('CircleCheckIcon'),
					value: on,
					onValueChange: (value: boolean) =>
						toggle(id, value).then(done => {
							if (!done) return
							toggled.set(id, value)
							rerender()
						}),
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
				h(TableRow, { key: 'remove', label: 'Uninstall', variant: 'danger', icon: icon('TrashIcon'), onPress: () => uninstall(plugin).then(done => done && syncState()) }),
			)
		} else if (entry?.enabled) {
			actions.push(
				h(TableRow, {
					key: 'install',
					label: installing === id ? 'Installing...' : 'Install',
					subLabel: plugin.version ? `Version ${plugin.version}` : undefined,
					icon: icon('DownloadIcon'),
					arrow: true,
					disabled: installing === id,
					onPress: async () => {
						setInstalling(id)
						await install(repo.url, plugin)
						setInstalling('')
						syncState()
					},
				}),
			)
		} else {
			actions.push(
				h(TableRow, {
					key: 'repo',
					label: entry ? 'Enable repository' : 'Add repository',
					subLabel: `${plugin.name} comes from ${repoName(repo)}`,
					icon: icon('DownloadIcon'),
					arrow: true,
					onPress: () => putRepos(slash(repo.url), true).then(syncState).catch(showError),
				}),
			)
		}

		return [
			h(TableRowGroup, { key: 'head', title: plugin.name, description: plugin.description }, [back]),
			h(TableRowGroup, { key: 'about', title: 'About' }, facts.filter(Boolean)),
			h(TableRowGroup, { key: 'actions', title: 'Actions' }, actions),
		]
	}

	const repoRow = (repo: Repo) => {
		const listing = listings.get(repo.url)
		const failed = listing?.err || listing?.stale

		let subLabel = 'Loading...'
		if (listing?.err) subLabel = friendlyError(listing.err)
		else if (listing?.stale) subLabel = `Couldn't refresh, showing ${listing.saved ? `copy saved ${ago(listing.saved)}` : 'earlier data'}`
		else if (listing) subLabel = listing.description || repo.url
		if (newRepos[repo.url]) subLabel = `New repository\n${subLabel}`

		let trailing
		if (failed) trailing = h(Button, { text: 'Retry', size: 'sm', variant: 'secondary', loading: retrying === repo.url, onPress: () => retry(repo) })
		else if (listing) trailing = h(TableRow.TrailingText, { text: `Plugins \u00b7 ${listing.plugins.length}` })

		return h(TableRow, {
			key: repo.url,
			icon: h(RepoAvatar, { repo, listing, epoch }),
			label: repoName(repo),
			subLabel,
			labelLineClamp: 1,
			subLabelLineClamp: newRepos[repo.url] ? 3 : 2,
			trailing,
			arrow: true,
			onPress: () => {
				dismissRepo(repo.url)
				showRepo(repo)
			},
		})
	}

	const emptyList = () => {
		const waiting = booting || refreshing
		return h(
			Stack,
			{ key: 'empty', spacing: 12 },
			h(Text, { variant: 'text-md/medium', color: 'text-muted' }, waiting ? 'Loading repositories...' : "Couldn't load the repository list. Check your connection and try again."),
			!waiting && h(Button, { text: 'Try again', size: 'md', variant: 'secondary', onPress: refreshAll }),
		)
	}

	const mainPage = () => {
		const hits = needle ? sortPlugins(catalog.flatMap(repo => (listings.get(repo.url)?.plugins ?? []).filter(pluginMatches).map(plugin => ({ repo, plugin })))) : []

		const shown = catalog.filter(repo => matches(repoName(repo), listings.get(repo.url)?.description, repo.url))
		const isNew = (repo: Repo) => (newRepos[repo.url] ? 1 : 0)
		const repos = sort === 'default' ? [...shown].sort((a, b) => isNew(b) - isNew(a)) : shown.sort((a, b) => repoRank(b) - repoRank(a) || repoName(a).localeCompare(repoName(b)))

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
			needle ? null : updatesSection(),
			needle ? null : feed('news', 'New plugins'),
			needle ? null : feed('updates', 'Recently updated'),
			catalog.length ? null : emptyList(),
			repos.length ? h(TableRowGroup, { key: 'all', title: 'Repositories', description: needle ? undefined : `${catalog.length} repositories` }, repos.map(repoRow)) : null,
		]
	}

	const body = detail ? pluginPage(detail.repo, detail.id) : current ? repoPage(current) : mainPage()
	return h(ScrollView, { style: { flex: 1 } }, h(Stack, { spacing: 16, style: { padding: 16 } }, body))
}

function RepoCount() {
	const { View } = revenge.react.ReactNative
	const { Text } = revenge.discord.design.Design
	const data = store.use()
	let unread = 0
	let fresh = 0
	try {
		unread = unreadCount(data)
		fresh = newRepoCount(data)
	} catch {
		// this sits in Discord's own settings list, a bad badge must never break it
	}
	const bubble = (count: number, color: string) =>
		h(
			View,
			{ style: { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: 10, marginRight: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: color } },
			h(Text, { variant: 'text-xs/bold', style: { color: '#FFFFFF' } }, count > 99 ? '99+' : String(count)),
		)
	return h(
		View,
		{ style: { flexDirection: 'row', alignItems: 'center' } },
		fresh > 0 && bubble(fresh, '#5865F2'),
		unread > 0 && bubble(unread, '#F23F42'),
		h(Text, { variant: 'text-md/medium', color: 'text-muted' }, String(catalog.length)),
	)
}

export default plugin({
	jsonStorage: { load: true, default: { seen: {}, ack: 0, snaps: {}, remote: null, known: null, newRepos: {}, updatesSeen: null, alerts: {} } },
	SettingsComponent: Browser,
	start({ cleanup, plugin, jsonStorage }) {
		if (plugin.startedLate) plugin.requireReload()
		store = jsonStorage
		repairStore()

		catalog = parseRepoList(jsonStorage.cache?.remote?.repos) ?? []
		for (const [url, snap] of Object.entries<any>(jsonStorage.cache?.snaps ?? {})) if (catalog.some(repo => repo.url === url)) listings.set(url, { ...snap.data, saved: snap.at })

		const settings = revenge.discord.modules.settings
		const undo: (() => void)[] = []
		let retry: any
		let attempts = 0
		let stopped = false

		const poll = () => checkUpdates().catch(() => {})
		poll().then(() => settings.refreshSettings())

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
	},
})
