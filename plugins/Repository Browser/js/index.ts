const REPOS = [
	{ url: 'https://k1ng0p.github.io/revenge-next-plugins/', source: 'https://github.com/k1ng0p/revenge-next-plugins' },
	{ url: 'https://bleelblep.github.io/revenge-next-plugins/', source: 'https://github.com/bleelblep/revenge-next-plugins' },
	{ url: 'https://next.jarviscli.dev/', source: 'https://next.jarviscli.dev/' },
	{ url: 'https://dev-next.jarviscli.dev/', source: 'https://github.com/everestmcarthur/revenge-next-plugs-dev' },
	{ url: 'https://contrabag.github.io/revenge-next-plugins/', source: 'https://github.com/contrabag/revenge-next-plugins' },
	{ url: 'https://rn.kmmiio99o.dev/', source: 'https://git.gay/kmmiio99o/revenge-next-plugins' },
	{ url: 'https://next.tralwdwd.dev/', source: 'https://github.com/tralwdwd/revenge-next-plugins' },
	{ url: 'https://mxtiy.knifecodez.workers.dev/', source: 'https://github.com/NoReplyUI5/revenge-next-plugins' },
] as { url: string; source?: string; icon?: string }[]

const KEY = 'RepositoryBrowser'
const WEEK = 7 * 864e5
const cache = new Map<string, any>()
let store: any
const h = (...a: any[]) => (revenge.react.React.createElement as any)(...a)
const call = (n: string, a: any[]) => (revenge.modules.native.callNativeMethod as any)(n, a)
const alert = (m: string) => modal('Repository Browser', m, B => [h(B, { key: 'o', text: 'OK', variant: 'secondary' })])
const asset = (n?: string) => (n ? revenge.assets.getAssetIdByName(n) : undefined)
const slash = (u: string) => u.replace(/\/*$/, '/')

const ago = (t: number) => {
	const m = Math.floor((Date.now() - t) / 6e4)
	if (m < 1) return 'just now'
	if (m < 60) return `${m}m ago`
	if (m < 1440) return `${Math.floor(m / 60)}h ago`
	return `${Math.floor(m / 1440)}d ago`
}

const icon = (v?: string, fallback = 'ListViewIcon') => {
	if (v && /^(data|https):/.test(v))
		return h(revenge.react.ReactNative.Image, { source: { uri: v }, style: { width: 24, height: 24, borderRadius: 12 } })
	return h(revenge.discord.design.Design.TableRow.Icon, { source: asset(v) ?? asset(fallback) ?? asset('ic_browse_channel') })
}

const avatar = (u?: string) => {
	const m = u?.match(/^https:\/\/(?:github\.com|([^./]+)\.github\.io)\/([^/]+)/)
	return m ? `https://github.com/${m[1] ?? m[2]}.png?size=96` : undefined
}

const repoIcon = (r: any, e: (typeof REPOS)[number]) => r?.icon ?? e.icon ?? avatar(e.source) ?? avatar(e.url)

async function load(url: string) {
	try {
		const res = await fetch(`${slash(url)}index.json?t=${Date.now()}`)
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		const json = await res.json()
		if (typeof json?.plugins !== 'object') throw new Error('Not a Revenge repository')
		cache.set(url, {
			name: json.name || url,
			description: json.description,
			icon: json.icon,
			plugins: Object.entries<any>(json.plugins).map(([id, p]) => ({
				id,
				name: p.name ?? id,
				description: p.description,
				author: p.author,
				icon: p.icon,
				version: p.channels?.latest,
			})),
		})
	} catch (e: any) {
		cache.set(url, { name: url, plugins: [], err: e?.message ?? String(e) })
	}
}

async function checkUpdates() {
	await Promise.all(REPOS.map(r => load(r.url)))
	const seen = { ...(store?.cache?.seen ?? {}) }
	let dirty = false
	for (const r of REPOS) {
		const c = cache.get(r.url)
		if (!c || c.err) continue
		const now: Record<string, string> = {}
		for (const p of c.plugins) now[p.id] = p.version ?? ''
		const sig = JSON.stringify(Object.entries(now).sort())
		const old = seen[r.url]
		if (old?.sig === sig) continue
		dirty = true
		if (!old) {
			seen[r.url] = { sig, versions: now, at: 0, changes: '' }
			continue
		}
		const lines: string[] = []
		for (const p of c.plugins) {
			const was = old.versions[p.id]
			if (was === undefined) lines.push(`New: ${p.name}`)
			else if (was !== now[p.id]) lines.push(`${p.name} ${was} to ${now[p.id]}`)
		}
		const more = lines.length > 3 ? ` +${lines.length - 3} more` : ''
		seen[r.url] = { sig, versions: now, at: Date.now(), changes: lines.slice(0, 3).join(', ') + more }
	}
	if (dirty) await store.set({ seen }, true)
}

const repoList = (): Promise<any[]> => call('revenge.plugins.repos.list', [])

async function readState() {
	const [repos, plugins, saved] = await Promise.all([
		repoList(),
		call('revenge.plugins.list', []),
		call('revenge.plugins.states.read', []),
	])
	const installed = new Map<string, { version: string; settings: boolean }>()
	for (const p of plugins ?? [])
		if (!p.internal)
			installed.set(p.manifest.id, {
				version: revenge.plugins.utils.formatVersion(p.manifest.version),
				settings: !!p.script?.includes('SettingsComponent'),
			})
	return { repos: repos as any[], installed, enabled: (saved?.states ?? {}) as Record<string, { enabled?: boolean; pendingReload?: boolean }> }
}

async function putRepos(url: string, enabled: boolean) {
	const all = await repoList()
	const list = all.filter(r => !r.internal).map(r => ({ url: r.url, enabled: slash(r.url) === slash(url) ? enabled : r.enabled }))
	if (!list.some(r => slash(r.url) === slash(url))) list.push({ url, enabled })
	await call('revenge.plugins.repos.set', [list])
	await call('revenge.plugins.repos.refresh', [url]).catch(() => {})
}

const openSettings = (id: string) => {
	const nav = revenge.discord.modules.mainTabsV2.RootNavigationRef.getRootNavigationRef()
	if (nav.isReady()) (nav as any).navigate(id)
}

const reload = () => call('revenge.app.reload', [])

const modal = (title: string, content: string, actions: (m: any) => any[], done?: () => void) => {
	const { AlertModal } = revenge.discord.design.Design
	revenge.discord.actions.AlertActionCreators.openAlert(
		`repository-browser-${title}`,
		h(AlertModal, { title, content: h(revenge.discord.design.Design.Text, { color: 'text-default' }, content), actions: h(revenge.react.React.Fragment, null, ...actions(revenge.discord.design.Design.AlertActionButton)) }),
		done,
	)
}

const askReload = (text: string) =>
	modal('Reload required', text, B => [
		h(B, { key: 'r', text: 'Reload', variant: 'primary', onPress: reload }),
		h(B, { key: 'l', text: 'Later', variant: 'secondary' }),
	])

const ask = (title: string, text: string, label = 'Install', variant = 'primary') =>
	new Promise<boolean>(done =>
		modal(title, text, B => [
			h(B, { key: 'y', text: label, variant, onPress: () => done(true) }),
			h(B, { key: 'n', text: 'Cancel', variant: 'secondary', onPress: () => done(false) }),
		], () => done(false)),
	)

async function uninstall(p: any) {
	if (!(await ask('Uninstall plugin?', `${p.name} and all of its data will be removed. This cannot be undone.`, 'Uninstall', 'destructive'))) return false
	try {
		await call('revenge.plugins.setEnabled', [p.id, false]).catch(() => {})
		await call('revenge.plugins.uninstall', [p.id])
		askReload('Uninstalled. Reload to apply it.')
		return true
	} catch (e: any) {
		alert(e?.message ?? String(e))
		return false
	}
}

async function install(url: string, p: any) {
	try {
		const all = await repoList()
		const hit = all.find(r => slash(r.url) === slash(url))
		if (!hit || !hit.enabled) await putRepos(url, true)
		const target = (await repoList()).find(r => slash(r.url) === slash(url))?.url ?? url
		const plan = await call('revenge.plugins.planInstall', [p.id, null, null, [target]])
		const extra = plan.actions.filter((a: any) => a.id !== p.id).map((a: any) => `${a.id} ${a.version}`)
		const lines = [`${p.name} ${plan.actions.find((a: any) => a.id === p.id)?.version ?? ''}`]
		if (extra.length) lines.push(`Also installs: ${extra.join(', ')}`)
		if (plan.warnings.length) lines.push(plan.warnings.join('\n'))
		if (!(await ask('Install plugin?', lines.join('\n\n')))) return false
		const res = await call('revenge.plugins.install', [plan])
		if (res.pending.length) askReload('Installed. Reload to apply it.')
		return true
	} catch (e: any) {
		alert(e?.message ?? String(e))
		return false
	}
}

async function toggle(id: string, on: boolean) {
	try {
		const res = await call('revenge.plugins.setEnabled', [id, on])
		if (res?.code) throw new Error(res.problems?.map((x: any) => `${x.id} (${x.required})`).join(', ') ?? res.code)
		askReload(`${on ? 'Enabled' : 'Disabled'}. Reload to apply it.`)
		return true
	} catch (e: any) {
		alert(e?.message ?? String(e))
		return false
	}
}

const flags = new Map<string, boolean>()

function Browser() {
	const { React } = revenge.react
	const { ScrollView, View, BackHandler, Linking } = revenge.react.ReactNative
	const { Stack, TableRow, TableRowGroup, TableSwitchRow, Button, IconButton, Card, Text } = revenge.discord.design.Design
	const { FormSwitch } = revenge.components
	const seen = store.use()?.seen ?? {}
	const [open, setOpen] = React.useState<(typeof REPOS)[number] | null>(null)
	const [st, setSt] = React.useState<Awaited<ReturnType<typeof readState>> | null>(null)
	const [busy, setBusy] = React.useState('')
	const [, update] = React.useReducer((n: number) => n + 1, 0)

	const sync = () => readState().then(setSt).catch(() => {})

	React.useEffect(() => {
		let alive = true
		sync()
		checkUpdates().then(() => alive && update())
		return () => void (alive = false)
	}, [])

	React.useEffect(() => {
		if (!open) return
		const sub = BackHandler.addEventListener('hardwareBackPress', () => (setOpen(null), true))
		return () => sub.remove()
	}, [open])

	const isOn = (id: string) => flags.get(id) ?? st?.enabled[id]?.enabled ?? false
	const added = (url: string) => st?.repos.find(r => !r.internal && slash(r.url) === slash(url))

	const plugin = (e: (typeof REPOS)[number], p: any) => {
		const have = st?.installed.get(p.id)
		const on = isOn(p.id)
		const live = on && !flags.has(p.id) && !st?.enabled[p.id]?.pendingReload
		const actions = have
			? [
					h(IconButton, { key: 'rm', size: 'sm', variant: 'secondary', icon: asset('TrashIcon'), onPress: () => uninstall(p).then(ok => ok && sync()) }),
					have.settings && h(IconButton, { key: 'cfg', size: 'sm', variant: 'secondary', icon: asset('SettingsIcon'), disabled: !live, onPress: () => openSettings(p.id) }),
					h(FormSwitch, { key: 'sw', value: on, onValueChange: (v: boolean) => toggle(p.id, v).then(ok => ok && (flags.set(p.id, v), update())) }),
				]
			: added(e.url)?.enabled
				? [
					h(Button, {
						key: 'in',
						text: 'Install',
						size: 'sm',
						icon: asset('DownloadIcon'),
						loading: busy === p.id,
						onPress: async () => {
							setBusy(p.id)
							await install(e.url, p)
							setBusy('')
							sync()
						},
					}),
				]
				: []
		const version = have?.version ?? p.version
		return h(
			Card,
			{ key: p.id, style: { paddingVertical: 12, paddingHorizontal: 12 } },
			h(
				View,
				{ style: { width: '100%' } },
				h(
					View,
					{ style: { flexDirection: 'row', alignItems: 'center', width: '100%' } },
					h(
						View,
						{ style: { flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 } },
						icon(p.icon, 'PuzzlePieceIcon'),
						h(Text, { variant: 'heading-lg/semibold', style: { flex: 1, marginLeft: 8 } }, p.name),
					),
					h(
						View,
						{ style: { flexDirection: 'row', alignItems: 'center', marginLeft: 8 } },
						...actions.filter(Boolean).map((c: any, i: number) => h(View, { key: i, style: { marginLeft: i ? 8 : 0 } }, c)),
					),
				),
				h(
					View,
					{ style: { paddingLeft: 32, marginTop: 6 } },
					h(Text, { color: 'text-muted', variant: 'heading-md/medium' }, `by ${p.author ?? 'unknown'}${version ? ` \u2022 ${version}` : ''}`),
					h(Text, { variant: 'text-md/medium', style: { marginTop: 4 } }, p.description),
				),
			),
		)
	}

	let body
	if (open) {
		const r = cache.get(open.url)
		const n = r?.plugins.length ?? 0
		const repo = added(open.url)
		body = [
			h(TableRowGroup, { key: 'info', title: r?.name ?? open.url, description: r?.description }, [
				h(TableRow, { key: 'back', label: 'Back', icon: icon('ArrowLargeLeftIcon'), onPress: () => setOpen(null) }),
				repo
					? h(TableSwitchRow, {
							key: 'repo',
							label: repo.enabled ? 'Repository enabled' : 'Repository disabled',
							subLabel: repo.enabled ? 'Added to Revenge' : 'Turn on to install its plugins',
							icon: icon(repo.enabled ? 'CircleCheckIcon' : 'CircleXIcon'),
							value: repo.enabled,
							onValueChange: (v: boolean) => putRepos(repo.url, v).then(sync),
						})
					: h(TableRow, {
							key: 'repo',
							label: 'Add to Revenge',
							subLabel: open.url,
							icon: icon('DownloadIcon'),
							arrow: true,
							onPress: () => putRepos(slash(open.url), true).then(sync).catch((e: any) => alert(e?.message ?? String(e))),
						}),
				h(TableRow, {
					key: 'link',
					label: open.source ? 'Source' : 'Website',
					subLabel: open.source ?? open.url,
					icon: icon(open.source ? 'PaperIcon' : 'GlobeEarthIcon'),
					arrow: true,
					onPress: () => Linking.openURL(open.source ?? open.url),
				}),
				h(TableRow, { key: 'refresh', label: 'Refresh', icon: icon('RetryIcon'), onPress: () => load(open.url).then(() => (sync(), update())) }),
			]),
			r?.err
				? h(Text, { key: 'err', variant: 'text-md/medium' }, `Failed to load: ${r.err}`)
				: h(
						Stack,
						{ key: 'plugins', spacing: 12 },
						h(Text, { variant: 'text-md/semibold', color: 'text-muted' }, `This repository comes with ${n} plugin${n === 1 ? '' : 's'}`),
						!repo?.enabled && h(Text, { key: 'hint', variant: 'text-sm/medium', color: 'text-muted' }, 'Add this repository to Revenge to install its plugins.'),
						...(r?.plugins.map((p: any) => plugin(open, p)) ?? []),
					),
		]
	} else {
		const recent = REPOS.filter(e => seen[e.url]?.at && Date.now() - seen[e.url].at < WEEK).sort((a, b) => seen[b.url].at - seen[a.url].at)
		body = [
			recent.length
				? h(
						TableRowGroup,
						{ key: 'recent', title: 'Recently updated' },
						recent.map(e => {
							const r = cache.get(e.url)
							return h(TableRow, {
								key: e.url,
								icon: icon(repoIcon(r, e)),
								label: r?.name ?? e.url,
								subLabel: `${seen[e.url].changes}\n${ago(seen[e.url].at)}`,
								subLabelLineClamp: 3,
								arrow: true,
								onPress: () => setOpen(e),
							})
						}),
					)
				: null,
			h(
				TableRowGroup,
				{ key: 'all', title: 'Repositories', description: `${REPOS.length} repositories` },
				REPOS.map(e => {
					const r = cache.get(e.url)
					const count = r && !r.err ? String(r.plugins.length) : ''
					return h(TableRow, {
						key: e.url,
						icon: icon(repoIcon(r, e)),
						label: r?.name ?? e.url,
						subLabel: r ? (r.err ? `Failed: ${r.err}` : r.description || e.url) : 'Loading...',
						labelLineClamp: 1,
						subLabelLineClamp: 2,
						trailing: count && h(TableRow.TrailingText, { text: `Plugins · ${count}` }),
						arrow: true,
						onPress: () => setOpen(e),
					})
				}),
			),
		]
	}

	return h(ScrollView, { style: { flex: 1 } }, h(Stack, { spacing: 16, style: { padding: 16 } }, body))
}

export default plugin({
	jsonStorage: { load: true, default: { seen: {} } },
	SettingsComponent: Browser,
	start({ cleanup, plugin, jsonStorage }) {
		if (plugin.startedLate) plugin.requireReload()
		store = jsonStorage
		checkUpdates().catch(() => {})

		const settings = revenge.discord.modules.settings
		const undo: (() => void)[] = []
		let timer: any

		const off = settings.onSettingsModulesLoaded(() => {
			undo.push(
				settings.registerSettingsItems({
					[KEY]: {
						type: 'route',
						parent: null,
						IconComponent: () => icon('ic_browse_channel'),
						useTitle: () => 'Unofficial Plugin Repositories',
						useTrailing: () => String(REPOS.length),
						screen: { route: KEY, getComponent: () => Browser },
					},
				}),
			)

			let tries = 0
			let polls = 0
			const join = () => {
				let moved = false
				try {
					const rm = settings.addSettingsItemToSection('REVENGE', items => {
						if (items[items.length - 1] === KEY) return items
						moved = true
						return [...items.filter(i => i !== KEY), KEY]
					})
					if (!polls) undo.push(rm)
				} catch {
					if (++tries < 500) timer = setTimeout(join, 20)
					return
				}
				if (moved) settings.refreshSettings()
				if (++polls < 24) timer = setTimeout(join, 250)
			}
			join()
		})

		cleanup(off, () => {
			clearTimeout(timer)
			undo.splice(0).forEach(fn => fn())
			settings.refreshSettings()
		})
	},
})
