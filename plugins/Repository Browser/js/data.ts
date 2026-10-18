import { ImportTrackerModuleId } from '@revenge-mod/discord/common/import-tracker'
import { LoggerModuleId } from '@revenge-mod/discord/common/logger'
import { Stores, withStoreName } from '@revenge-mod/discord/flux'
import { filters, lookupModule } from '@revenge-mod/modules/finders'
import { ReactNative } from '@revenge-mod/react'
import { available, refreshAvailable } from './revenge'
import { AVATAR_TTL, MAX_REQUESTS, RECHECK_AFTER_FOCUS, REMOTE_LIST, asObject, errorMessage, hostOf, isRemote, reportError, slash, sleep } from './shared'
import type { AlertMode, ListedPlugin, Listing, Repo } from './shared'

export type SeenEntry = {
	sig: string
	versions: Record<string, string>
	news: Record<string, number>
	updates: Record<string, { at: number; from: string; to: string }>
	meta: Record<string, { added?: number; updated?: number }>
	ever?: string[]
}

export type StoreData = {
	seen: Record<string, SeenEntry>
	ack: number
	snaps: Record<string, { at: number; data: Listing }>
	remote: { repos: Repo[] } | null
	known: string[] | null
	newRepos: Record<string, number>
	updatesSeen: Record<string, Record<string, number>> | null
	alerts: Record<string, AlertMode>
}

type JsonStore = {
	cache: unknown
	loaded?: boolean
	get?: () => Promise<unknown>
	set: (value: unknown, flush?: boolean) => Promise<unknown>
	use: () => any
}

let store: JsonStore
let writes: Promise<unknown> = Promise.resolve()

export const bindStore = (jsonStorage: JsonStore) => {
	store = jsonStorage
}

export const useStore = (): Partial<StoreData> | undefined => store.use()

// the storage file is read in the background, anything written before that would replace it with defaults
export async function whenLoaded() {
	for (let waited = 0; store.loaded === false && waited < 5000; waited += 25) await sleep(25)
	if (store.loaded === false) await store.get?.()
}

export function readStore(): StoreData {
	const raw = asObject(store.cache)
	return {
		seen: asObject(raw.seen),
		ack: typeof raw.ack === 'number' ? raw.ack : 0,
		snaps: asObject(raw.snaps),
		remote: raw.remote && typeof raw.remote === 'object' ? raw.remote : null,
		known: Array.isArray(raw.known) ? raw.known : null,
		newRepos: asObject(raw.newRepos),
		updatesSeen: raw.updatesSeen && typeof raw.updatesSeen === 'object' ? raw.updatesSeen : null,
		alerts: asObject(raw.alerts),
	}
}

// writes run one after another so two overlapping updates can't overwrite each other
export function update(change: (data: StoreData) => Partial<StoreData>) {
	const job = writes.then(async () => {
		await whenLoaded()
		const current = readStore()
		const next = { ...current, ...change(current) }
		if (JSON.stringify(next) !== JSON.stringify(store.cache)) await store.set(next, true)
	})
	writes = job.catch(reportError)
	return writes
}

export const save = (patch: Partial<StoreData>) => update(() => patch)

export const setAlertMode = (url: string, mode: AlertMode) => update(data => ({ alerts: { ...data.alerts, [url]: mode } }))

export function dismiss(kind: 'news' | 'updates', url: string, id: string) {
	return update(data => {
		const entry = data.seen[url]
		if (!entry?.[kind]?.[id]) return {}
		const remaining = { ...entry[kind] }
		delete remaining[id]
		return { seen: { ...data.seen, [url]: { ...entry, [kind]: remaining } } }
	})
}

export const dismissAll = (kind: 'news' | 'updates') =>
	update(data => ({ seen: Object.fromEntries(Object.entries(data.seen).map(([url, entry]) => [url, { ...entry, [kind]: {} }])) }))

export function dismissRepo(url: string) {
	return update(data => {
		const newRepos = { ...data.newRepos }
		delete newRepos[url]
		return { newRepos }
	})
}

const ackOf = (data?: Partial<StoreData>) => (typeof data?.ack === 'number' ? data.ack : 0)

export function unreadCount(data: Partial<StoreData> | undefined, catalog: Repo[]) {
	const seen = asObject(data?.seen)
	const alerts = asObject(data?.alerts)
	const updatesSeen = asObject(data?.updatesSeen)
	const ack = ackOf(data)

	let total = 0
	for (const repo of catalog) {
		const mode: AlertMode = alerts[repo.url] ?? 'news'
		if (mode === 'all' || mode === 'news') total += Object.values<number>(asObject(seen[repo.url]?.news)).filter(at => at > ack).length
		if (mode === 'all' || mode === 'updates') total += Object.values<number>(asObject(updatesSeen[repo.url])).filter(at => at > ack).length
	}
	return total
}

export function newRepoCount(data: Partial<StoreData> | undefined, catalog: Repo[]) {
	const ack = ackOf(data)
	return Object.entries<number>(asObject(data?.newRepos)).filter(([url, at]) => at > ack && catalog.some(repo => repo.url === url)).length
}

// the epoch goes into image urls so changed pictures don't come from the image cache
let avatarEpoch = Date.now()
const discordUsers = new Map<string, { avatar: string | null; name: string | null; epoch: number }>()

export function freshAvatarEpoch(force = false) {
	if (force || Date.now() - avatarEpoch > AVATAR_TTL) avatarEpoch = Date.now()
	return avatarEpoch
}

export const cachedAvatar = (id: string) => discordUsers.get(id)?.avatar ?? null

function knownUser(id: string) {
	try {
		return Stores.UserStore?.getUser?.(id)
	} catch {
		return undefined
	}
}

export async function discordUser(id: string) {
	const cached = discordUsers.get(id)
	if (cached?.epoch === avatarEpoch) return cached

	let hash: string | null | undefined
	let name: string | null | undefined
	try {
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

export function githubAvatar(url: string | undefined, epoch: number) {
	const match = url?.match(/^https:\/\/(?:github\.com|([^./]+)\.github\.io)\/([^/]+)/)
	return match ? `https://github.com/${match[1] ?? match[2]}.png?size=96&v=${epoch}` : undefined
}

const authors = new Map<string, { name: string; ids: string[] }>()

export function parseAuthor(raw = '') {
	let parsed = authors.get(raw)
	if (!parsed) {
		const author = raw.trim()
		const start = author.search(/[<(]/)
		const name = (start === -1 ? author : author.slice(0, start)).trim() || author.slice(0, 60) || 'unknown'
		const ids = (author.match(/<\d{17,20}>/g) ?? []).map(entry => entry.slice(1, -1))
		parsed = { name, ids }
		authors.set(raw, parsed)
	}
	return parsed
}

export function repoOwner(repo: Repo) {
	const address = repo.source ?? repo.url
	const match = address.match(/^https:\/\/(?:github\.com\/([^/]+)|([^./]+)\.github\.io)/)
	return match ? (match[1] ?? match[2]) : (address.match(/^https:\/\/([^/]+)/)?.[1] ?? address)
}

let profileSheet: ((props: { userId: string }) => void) | undefined

// the same sheet Revenge opens for plugin authors
function findProfileSheet() {
	const named = filters.withName('showUserProfileActionSheet')
	const { ordered, relative } = filters.withDependencies
	const storeId = (name: string) => lookupModule(withStoreName(name))[1]

	try {
		const exact = lookupModule(
			named.and(filters.withDependencies(ordered([LoggerModuleId, storeId('UserStore'), relative(1), relative(2), relative(3), ImportTrackerModuleId]))),
		)[0]
		if (exact) return exact
	} catch {
		// the exact match depends on Discord's module layout, the name alone is the fallback
	}

	try {
		return lookupModule(named)[0]
	} catch {
		return undefined
	}
}

export function openUserProfile(userId: string) {
	profileSheet ??= findProfileSheet()
	if (profileSheet) profileSheet({ userId })
	else ReactNative.Linking.openURL(`https://discord.com/users/${userId}`)
}

export const catalog: Repo[] = []
export const listings = new Map<string, Listing>()

const pending = new Map<string, Promise<void>>()
const waiting: (() => void)[] = []
let running = 0
let lastCheck = 0
let ready: Promise<unknown> = Promise.resolve()

export const checkedRecently = () => Date.now() - lastCheck < RECHECK_AFTER_FOCUS

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
		// the second attempt goes without ?t= in case the host dislikes query strings
		const query = attempt === 1 ? '' : `?t=${Date.now()}`
		const res = await fetch(`${slash(url)}index.json${query}`, { signal: controller.signal })
		if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { permanent: res.status < 500 && res.status !== 429 })
		const json = await res.json()
		if (!json?.plugins || typeof json.plugins !== 'object' || Array.isArray(json.plugins)) throw Object.assign(new Error('Not a Revenge repository'), { permanent: true })
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

const text = (value: any, max: number) => (typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, max) : undefined)
const shortLink = (value: any) => (typeof value === 'string' && value.length <= 300 ? value : undefined)

const trustedHosts = /(^|\.)(github\.com|githubusercontent\.com|github\.io|discordapp\.com)$/

// remote icons are fetched by the app, so only the repository's own host and well-known CDNs are allowed
function safeIcon(value: any, repoUrl: string) {
	const link = shortLink(value)
	if (!link || !isRemote(link)) return link
	const host = hostOf(link)
	return host === hostOf(repoUrl) || trustedHosts.test(host) ? link : undefined
}

// repositories are written by other people, so only short, plain values get through
function cleanListing(raw: any, url: string): Listing {
	const plugins: ListedPlugin[] = []
	for (const item of Array.isArray(raw?.plugins) ? raw.plugins : []) {
		const id = text(item?.id, 100)
		if (!id || plugins.length >= 300) continue
		plugins.push({
			id,
			name: text(item.name, 80) || id,
			description: text(item.description, 400),
			author: text(item.author, 200),
			icon: safeIcon(item.icon, url),
			version: text(item.version, 40),
			size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : undefined,
			requires: (Array.isArray(item.requires) ? item.requires : [])
				.map((entry: any) => text(entry, 100))
				.filter(Boolean)
				.slice(0, 20) as string[],
		})
	}
	return {
		at: typeof raw?.at === 'number' ? raw.at : undefined,
		name: text(raw?.name, 80) || url,
		description: text(raw?.description, 300),
		icon: safeIcon(raw?.icon, url),
		plugins,
	}
}

function toListing(url: string, json: any): Listing {
	const plugins = Object.entries<any>(json.plugins)
		.filter(([, plugin]) => plugin && typeof plugin === 'object')
		.map(([id, plugin]) => {
			const version = plugin.channels?.latest
			const build = plugin.versions?.[version]
			return {
				id,
				name: plugin.name,
				description: plugin.description,
				author: plugin.author,
				icon: plugin.icon,
				version,
				size: build?.size,
				requires: Object.entries<any>(build?.dependencies ?? {}).map(([dep, info]) => `${dep} ${info?.version ?? ''}${info?.optional ? ' (optional)' : ''}`.trim()),
			}
		})
	return cleanListing({ at: Date.now(), name: json.name, description: json.description, icon: json.icon, plugins }, url)
}

export function load(url: string) {
	const inProgress = pending.get(url)
	if (inProgress) return inProgress

	const job = takeSlot()
		.then(() => fetchRepo(url))
		.then(json => {
			const fresh = toListing(url, json)
			const previous = listings.get(url)
			// one empty reply from a repository that had plugins is more likely an outage than a cleanup
			if (!fresh.plugins.length && previous?.plugins.length && !previous.err) listings.set(url, { ...previous, stale: 'Repository sent an empty list' })
			else listings.set(url, fresh)
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

export function parseRepoList(json: any): Repo[] | null {
	const items = Array.isArray(json) ? json : json?.repos
	if (!Array.isArray(items)) return null

	const repos: Repo[] = []
	for (const item of items) {
		const url = typeof item?.url === 'string' ? item.url.trim() : ''
		if (!/^https:\/\/[^\s/]+/.test(url) || repos.some(repo => slash(repo.url) === slash(url))) continue

		const repo: Repo = { url: slash(url) }
		if (typeof item.source === 'string' && /^https:\/\//.test(item.source.trim())) repo.source = item.source.trim()
		if (typeof item.discord === 'string' && /^\d{15,25}$/.test(item.discord.trim())) repo.discord = item.discord.trim()

		const badges = (Array.isArray(item.badges) ? item.badges : [])
			.filter((badge: unknown): badge is string => typeof badge === 'string')
			.map((badge: string) => badge.trim().slice(0, 16))
			.filter(Boolean)
			.slice(0, 3)
		if (badges.length) repo.badges = badges
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
			// offline or timed out, the saved list stays in use
		} finally {
			clearTimeout(timer)
		}
		if (attempt === 0) await sleep(800)
	}
	return null
}

async function refreshCatalog() {
	const next = await fetchRepoList()
	if (!next) return

	catalog.splice(0, catalog.length, ...next)
	await update(data => {
		const first = !data.known
		const known = new Set(data.known ?? next.map(repo => repo.url))
		const newRepos = { ...data.newRepos }
		if (!first) {
			for (const repo of next) {
				if (known.has(repo.url)) continue
				known.add(repo.url)
				newRepos[repo.url] = Date.now()
			}
		}

		const urls = new Set(next.map(repo => repo.url))
		const keep = (all: Record<string, any>) => Object.fromEntries(Object.entries(all).filter(([url]) => urls.has(url)))
		for (const url of Object.keys(newRepos)) if (!urls.has(url)) delete newRepos[url]

		return { remote: { repos: next }, known: [...known], newRepos, seen: keep(data.seen), snaps: keep(data.snaps) }
	})
}

function diffRepo(old: SeenEntry | undefined, listing: Listing): SeenEntry {
	const versions: Record<string, string> = {}
	for (const plugin of listing.plugins) versions[plugin.id] = plugin.version ?? ''
	const sig = JSON.stringify(Object.entries(versions).sort())

	if (!old) return { sig, versions, news: {}, updates: {}, meta: {}, ever: Object.keys(versions) }
	if (old.sig === sig) return old

	const now = Date.now()
	const news = { ...old.news }
	const updates = { ...old.updates }
	const meta = { ...old.meta }
	const ever = new Set(old.ever ?? Object.keys(old.versions))

	for (const plugin of listing.plugins) {
		const before = old.versions[plugin.id]
		if (before === undefined) {
			if (ever.has(plugin.id)) continue
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

	for (const id of Object.keys(versions)) ever.add(id)
	return { sig, versions, news, updates, meta, ever: [...ever].slice(-1000) }
}

const sameContent = (a?: Listing, b?: Listing) => JSON.stringify({ ...a, at: 0, saved: 0 }) === JSON.stringify({ ...b, at: 0, saved: 0 })

function trackUpdates(previous: StoreData['updatesSeen'], checked: Set<string>) {
	const first = !previous
	const updatesSeen = { ...previous }
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

export async function checkUpdates(only?: string[], onEach?: () => void) {
	await ready
	const inScope = (repo: Repo) => !only || only.includes(repo.url)
	const loadAll = (list: Repo[]) => Promise.all(list.map(repo => load(repo.url).then(onEach)))

	const catalogJob = only ? undefined : refreshCatalog()
	await loadAll(catalog.filter(inScope))
	await catalogJob
	await loadAll(catalog.filter(repo => inScope(repo) && !listings.has(repo.url)))
	const repos = catalog.filter(inScope)

	const checked = only
		? null
		: await refreshAvailable(catalog).catch(error => {
				reportError(error)
				return null
			})
	lastCheck = Date.now()

	await update(data => {
		const seen = { ...data.seen }
		const snaps = { ...data.snaps }
		for (const repo of repos) {
			const listing = listings.get(repo.url)
			if (!listing || listing.err || listing.stale) continue
			seen[repo.url] = diffRepo(seen[repo.url], listing)
			if (!sameContent(snaps[repo.url]?.data, listing)) snaps[repo.url] = { at: Date.now(), data: listing }
		}
		return checked ? { seen, snaps, updatesSeen: trackUpdates(data.updatesSeen, checked) } : { seen, snaps }
	})
}

// puts the saved repository list and listing snapshots back, checkUpdates waits for this
export function restore() {
	ready = whenLoaded().then(() => {
		const data = readStore()
		catalog.splice(0, catalog.length, ...(parseRepoList(data.remote?.repos) ?? []))
		for (const [url, snap] of Object.entries<any>(data.snaps)) {
			if (catalog.some(repo => repo.url === url)) listings.set(url, { ...cleanListing(snap?.data, url), saved: snap?.at })
		}
		return update(() => ({}))
	})
}

// requirements are listed as "id 1.2.0" or "id 1.2.0 (optional)"
export function dependentsOf(id: string, installed: Map<string, unknown>) {
	const names = new Set<string>()
	for (const listing of listings.values()) {
		for (const plugin of listing.plugins) {
			if (plugin.id === id || !installed.has(plugin.id)) continue
			const need = plugin.requires?.find(entry => entry.split(' ')[0] === id)
			if (need) names.add(need.endsWith('(optional)') ? `${plugin.name} (optional)` : plugin.name)
		}
	}
	return [...names]
}
