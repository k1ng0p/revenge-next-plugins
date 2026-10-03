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
const DAY = 864e5
const SORTS = { name: 'A-Z', updated: 'Recently updated', newest: 'Newest', installed: 'Installed first' } as Record<string, string>
const cache = new Map<string, any>()
let store: any
const h = (...a: any[]) => (revenge.react.React.createElement as any)(...a)
const call = (n: string, a: any[]) => (revenge.modules.native.callNativeMethod as any)(n, a)
const alert = (m: string) => modal('Plugin Browser', m, B => [h(B, { key: 'o', text: 'OK', variant: 'secondary' })])
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

const save = (patch: Record<string, any>) =>
	store.set({ seen: store.cache?.seen ?? {}, ack: store.cache?.ack ?? 0, ...patch }, true)

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
			seen[r.url] = { sig, versions: now, news: {}, updates: {}, meta: {} }
			continue
		}
		const stamp = Date.now()
		const news = { ...old.news }
		const updates = { ...old.updates }
		const meta = { ...old.meta }
		for (const p of c.plugins) {
			const was = old.versions[p.id]
			if (was === undefined) {
				news[p.id] = stamp
				meta[p.id] = { ...meta[p.id], added: stamp }
			} else if (was !== now[p.id]) {
				updates[p.id] = { at: stamp, from: was, to: now[p.id] }
				meta[p.id] = { ...meta[p.id], updated: stamp }
			}
		}
		for (const id of Object.keys(old.versions))
			if (!(id in now)) {
				delete news[id]
				delete updates[id]
				delete meta[id]
			}
		seen[r.url] = { sig, versions: now, news, updates, meta }
	}
	if (dirty) await save({ seen })
}

function dismiss(kind: 'news' | 'updates', url: string, id: string) {
	const seen = store.cache?.seen ?? {}
	const entry = seen[url]
	if (!entry?.[kind]?.[id]) return
	const next = { ...entry[kind] }
	delete next[id]
	return save({ seen: { ...seen, [url]: { ...entry, [kind]: next } } })
}

const unreadCount = (seen: Record<string, any>, ack: number) =>
	Object.values(seen).reduce((sum: number, r: any) => sum + Object.values<number>(r.news ?? {}).filter(at => at > ack).length, 0)

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
		`plugin-browser-${title}`,
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
	const { Stack, TableRow, TableRowGroup, TableSwitchRow, TableRadioGroup, TableRadioRow, Button, IconButton, Card, Text } = revenge.discord.design.Design
	const { FormSwitch, SearchInput } = revenge.components
	const seen = store.use()?.seen ?? {}
	const [open, setOpen] = React.useState<(typeof REPOS)[number] | null>(null)
	const [st, setSt] = React.useState<Awaited<ReturnType<typeof readState>> | null>(null)
	const [busy, setBusy] = React.useState('')
	const [query, setQuery] = React.useState('')
	const [sort, setSort] = React.useState('name')
	const [sortOpen, setSortOpen] = React.useState(false)
	const [, update] = React.useReducer((n: number) => n + 1, 0)

	const sync = () => readState().then(setSt).catch(() => {})
	const openRepo = (e: (typeof REPOS)[number]) => {
		setQuery('')
		setSortOpen(false)
		setOpen(e)
	}
	const closeRepo = () => {
		setQuery('')
		setSortOpen(false)
		setOpen(null)
	}

	React.useEffect(() => {
		let alive = true
		save({ ack: Date.now() })
		sync()
		checkUpdates().then(() => {
			if (!alive) return
			save({ ack: Date.now() })
			update()
		})
		return () => void (alive = false)
	}, [])

	React.useEffect(() => {
		if (!open) return
		const sub = BackHandler.addEventListener('hardwareBackPress', () => (closeRepo(), true))
		return () => sub.remove()
	}, [open])

	const isOn = (id: string) => flags.get(id) ?? st?.enabled[id]?.enabled ?? false
	const added = (url: string) => st?.repos.find(r => !r.internal && slash(r.url) === slash(url))

	const q = query.trim().toLowerCase()
	const matches = (...fields: any[]) => !q || fields.some(f => typeof f === 'string' && f.toLowerCase().includes(q))
	const byName = (a: string, b: string) => a.localeCompare(b)
	const repoName = (e: (typeof REPOS)[number]) => cache.get(e.url)?.name ?? e.url

	const pluginRank = (e: (typeof REPOS)[number], p: any) => {
		const m = seen[e.url]?.meta?.[p.id]
		if (sort === 'updated') return m?.updated ?? 0
		if (sort === 'newest') return m?.added ?? 0
		if (sort === 'installed') return st?.installed.has(p.id) ? 1 : 0
		return 0
	}

	const repoRank = (e: (typeof REPOS)[number]) => {
		const metas = Object.values<any>(seen[e.url]?.meta ?? {})
		if (sort === 'updated') return Math.max(0, ...metas.map(m => Math.max(m.updated ?? 0, m.added ?? 0)))
		if (sort === 'newest') return Math.max(0, ...metas.map(m => m.added ?? 0))
		if (sort === 'installed')
			return (cache.get(e.url)?.plugins ?? []).filter((p: any) => st?.installed.has(p.id)).length * 2 + (added(e.url)?.enabled ? 1 : 0)
		return 0
	}

	const sortPlugins = (items: { e: (typeof REPOS)[number]; p: any }[]) =>
		[...items].sort((a, b) => pluginRank(b.e, b.p) - pluginRank(a.e, a.p) || byName(a.p.name, b.p.name))

	const plugin = (e: (typeof REPOS)[number], p: any, origin?: string) => {
		const have = st?.installed.get(p.id)
		const repo = added(e.url)
		const on = isOn(p.id)
		const live = on && !flags.has(p.id) && !st?.enabled[p.id]?.pendingReload
		const actions = !st
			? []
			: have
				? [
						h(IconButton, { key: 'rm', size: 'sm', variant: 'secondary', icon: asset('TrashIcon'), onPress: () => uninstall(p).then(ok => ok && sync()) }),
						have.settings && h(IconButton, { key: 'cfg', size: 'sm', variant: 'secondary', icon: asset('SettingsIcon'), disabled: !live, onPress: () => openSettings(p.id) }),
						h(FormSwitch, { key: 'sw', value: on, onValueChange: (v: boolean) => toggle(p.id, v).then(ok => ok && (flags.set(p.id, v), update())) }),
					]
				: repo?.enabled
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
					: [
							h(Button, {
								key: 'repo',
								text: origin ? 'Open repo' : repo ? 'Enable repo' : 'Add repo',
								size: 'sm',
								variant: 'secondary',
								onPress: () => (origin ? openRepo(e) : putRepos(slash(e.url), true).then(sync).catch((err: any) => alert(err?.message ?? String(err)))),
							}),
						]
		const version = have?.version ?? p.version
		return h(
			Card,
			{ key: `${e.url}#${p.id}`, style: { paddingVertical: 12, paddingHorizontal: 12 } },
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
					origin && h(Text, { color: 'text-muted', variant: 'text-sm/medium', style: { marginTop: 2 } }, `from ${origin}${repo?.enabled ? '' : ' \u2022 repository not added'}`),
					h(Text, { variant: 'text-md/medium', style: { marginTop: 4 } }, p.description),
				),
			),
		)
	}

	const controls = () =>
		h(
			View,
			{ key: 'controls', style: { flexDirection: 'row', alignItems: 'center' } },
			h(View, { style: { flex: 1 } }, h(SearchInput, { value: query, onChange: setQuery, isClearable: true, placeholder: open ? 'Search this repository' : 'Search plugins and repositories' })),
			h(
				View,
				{ style: { marginLeft: 8 } },
				h(IconButton, { size: 'md', variant: sortOpen ? 'primary' : 'secondary', icon: asset('FiltersHorizontalIcon'), onPress: () => setSortOpen((v: boolean) => !v) }),
			),
		)

	const sortUi = (ranks: number[]) => [
		h(
			Text,
			{ key: 'sorted', variant: 'text-sm/medium', color: 'text-muted' },
			`Sorted by ${SORTS[sort]}${(sort === 'updated' || sort === 'newest') && !ranks.some(Boolean) ? ' (no history yet, showing A-Z)' : ''}`,
		),
		sortOpen &&
			h(
				TableRadioGroup,
				{ key: 'sort', title: 'Sort by', defaultValue: sort, onChange: (v: string) => (setSort(v), setSortOpen(false)) },
				Object.entries(SORTS).map(([k, label]) => h(TableRadioRow, { key: k, label, value: k })),
			),
	]

	const warning = () => {
		const source = asset('WarningIcon') ?? asset('CircleExclamationPointIcon')
		return h(
			View,
			{ key: 'warning', style: { flexDirection: 'row', padding: 12, borderRadius: 12, borderWidth: 1, borderColor: '#F23F42', backgroundColor: 'rgba(242, 63, 66, 0.12)' } },
			source && h(View, { style: { marginRight: 10, paddingTop: 2 } }, h(TableRow.Icon, { source })),
			h(
				View,
				{ style: { flex: 1 } },
				h(Text, { variant: 'heading-md/bold', style: { color: '#FF7B7E' } }, 'Unofficial plugins and repositories'),
				h(
					Text,
					{ variant: 'text-sm/medium', style: { marginTop: 4 } },
					'Plugins installed from unofficial sources can run unverified code in this app without your awareness. Check the source first, and install at your own risk.',
				),
			),
		)
	}

	const feed = (kind: 'news' | 'updates', title: string) => {
		const items = REPOS.flatMap(e =>
			Object.entries<any>(seen[e.url]?.[kind] ?? {}).map(([id, v]) => ({ e, id, v, at: kind === 'news' ? (v as number) : v.at })),
		)
			.filter(i => (kind === 'news' || (Date.now() - i.at < DAY && !seen[i.e.url].news?.[i.id])) && cache.get(i.e.url)?.plugins.some((p: any) => p.id === i.id))
			.sort((a, b) => b.at - a.at)
		if (!items.length) return null
		return h(
			TableRowGroup,
			{ key: kind, title },
			items.map(({ e, id, v, at }) => {
				const r = cache.get(e.url)
				const p = r.plugins.find((x: any) => x.id === id)
				const detail = kind === 'news' ? `New in ${r.name}` : `Updated in ${r.name}\n${v.from} to ${v.to}`
				return h(TableRow, {
					key: `${kind}:${e.url}#${id}`,
					icon: icon(p.icon, 'PuzzlePieceIcon'),
					label: p.name,
					subLabel: `${detail}\n${ago(at)}`,
					subLabelLineClamp: 3,
					arrow: true,
					onPress: () => {
						dismiss(kind, e.url, id)
						openRepo(e)
					},
				})
			}),
		)
	}

	let body
	if (open) {
		const r = cache.get(open.url)
		const n = r?.plugins.length ?? 0
		const repo = added(open.url)
		const visible = sortPlugins((r?.plugins ?? []).filter((p: any) => matches(p.name, p.id, p.description, p.author)).map((p: any) => ({ e: open, p })))
		body = [
			h(TableRowGroup, { key: 'info', title: r?.name ?? open.url, description: r?.description }, [
				h(TableRow, { key: 'back', label: 'Back', icon: icon('ArrowLargeLeftIcon'), onPress: closeRepo }),
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
						controls(),
						...sortUi(visible.map(({ e, p }) => pluginRank(e, p))),
						q && !visible.length && h(Text, { key: 'none', variant: 'text-md/medium' }, `No plugins match "${query.trim()}".`),
						...visible.map(({ p }) => plugin(open, p)),
					),
		]
	} else {
		const hits = q
			? sortPlugins(REPOS.flatMap(e => (cache.get(e.url)?.plugins ?? []).filter((p: any) => matches(p.name, p.id, p.description, p.author)).map((p: any) => ({ e, p }))))
			: []
		const repos = REPOS.filter(e => matches(repoName(e), cache.get(e.url)?.description, e.url)).sort(
			(a, b) => repoRank(b) - repoRank(a) || byName(repoName(a), repoName(b)),
		)
		body = [
			controls(),
			warning(),
			...sortUi(q ? hits.map(({ e, p }) => pluginRank(e, p)) : repos.map(repoRank)),
			q
				? hits.length
					? h(
							Stack,
							{ key: 'hits', spacing: 12 },
							h(Text, { variant: 'text-md/semibold', color: 'text-muted' }, `${hits.length} plugin${hits.length === 1 ? '' : 's'} found`),
							...hits.map(({ e, p }) => plugin(e, p, repoName(e))),
						)
					: h(Text, { key: 'none', variant: 'text-md/medium' }, `No plugins match "${query.trim()}".`)
				: null,
			q ? null : feed('news', 'New plugins'),
			q ? null : feed('updates', 'Recently updated'),
			repos.length
				? h(
						TableRowGroup,
						{ key: 'all', title: 'Repositories', description: q ? undefined : `${REPOS.length} repositories` },
						repos.map(e => {
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
								onPress: () => openRepo(e),
							})
						}),
					)
				: null,
		]
	}

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
	jsonStorage: { load: true, default: { seen: {}, ack: 0 } },
	SettingsComponent: Browser,
	start({ cleanup, plugin, jsonStorage }) {
		if (plugin.startedLate) plugin.requireReload()
		store = jsonStorage

		const settings = revenge.discord.modules.settings
		const undo: (() => void)[] = []
		let timer: any
		let tries = 0

		checkUpdates()
			.then(() => settings.refreshSettings())
			.catch(() => {})

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

			const place = () => {
				try {
					settings.addSettingsItemToSection('REVENGE', items => items)()
				} catch {
					if (++tries < 500) timer = setTimeout(place, 20)
					return
				}
				undo.push(
					settings.registerSettingsSection
						? settings.registerSettingsSection(KEY, { label: 'Plugin Browser', settings: [KEY], index: 1 })
						: settings.addSettingsItemToSection('REVENGE', KEY),
				)
				settings.refreshSettings()
			}
			place()
		})

		cleanup(off, () => {
			clearTimeout(timer)
			undo.splice(0).forEach(fn => fn())
			settings.refreshSettings()
		})
	},
})
