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
const cache = new Map<string, any>()
const h = (...a: any[]) => (revenge.react.React.createElement as any)(...a)
const call = (n: string, a: any[]) => (revenge.modules.native.callNativeMethod as any)(n, a)
const alert = (m: string) => revenge.react.ReactNative.Alert.alert('Repository Browser', m)
const asset = (n?: string) => (n ? revenge.assets.getAssetIdByName(n) : undefined)
const slash = (u: string) => u.replace(/\/*$/, '/')

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

async function addRepo(url: string) {
	try {
		const all: any[] = await call('revenge.plugins.repos.list', [])
		if (all.some(r => slash(r.url) === url)) return alert('Already added.')
		const list = all.filter(r => !r.internal).map(r => ({ url: r.url, enabled: r.enabled }))
		await call('revenge.plugins.repos.set', [[...list, { url, enabled: true }]])
		await call('revenge.plugins.repos.refresh', [url]).catch(() => {})
		alert('Repository added.')
	} catch (e) {
		alert(String(e))
	}
}

function Browser() {
	const { React } = revenge.react
	const { ScrollView, BackHandler, Linking } = revenge.react.ReactNative
	const { Stack, TableRow, TableRowGroup, Text } = revenge.discord.design.Design
	const [open, setOpen] = React.useState<(typeof REPOS)[number] | null>(null)
	const [, update] = React.useReducer((n: number) => n + 1, 0)

	React.useEffect(() => {
		let alive = true
		Promise.all(REPOS.map(r => load(r.url))).then(() => alive && update())
		return () => void (alive = false)
	}, [])

	React.useEffect(() => {
		if (!open) return
		const sub = BackHandler.addEventListener('hardwareBackPress', () => (setOpen(null), true))
		return () => sub.remove()
	}, [open])

	let body
	if (open) {
		const r = cache.get(open.url)
		const n = r?.plugins.length ?? 0
		body = [
			h(TableRowGroup, { key: 'info', title: r?.name ?? open.url, description: r?.description }, [
				h(TableRow, { key: 'back', label: 'Back', icon: icon('ArrowLargeLeftIcon'), onPress: () => setOpen(null) }),
				h(TableRow, { key: 'add', label: 'Add to Revenge', subLabel: open.url, icon: icon('DownloadIcon'), arrow: true, onPress: () => addRepo(slash(open.url)) }),
				h(TableRow, {
					key: 'link',
					label: open.source ? 'Source' : 'Website',
					subLabel: open.source ?? open.url,
					icon: icon(open.source ? 'PaperIcon' : 'GlobeEarthIcon'),
					arrow: true,
					onPress: () => Linking.openURL(open.source ?? open.url),
				}),
				h(TableRow, { key: 'refresh', label: 'Refresh', icon: icon('RetryIcon'), onPress: () => load(open.url).then(update) }),
			]),
			r?.err
				? h(Text, { key: 'err', variant: 'text-md/medium' }, `Failed to load: ${r.err}`)
				: h(
						TableRowGroup,
						{ key: 'plugins', title: `This repository comes with ${n} plugin${n === 1 ? '' : 's'}` },
						r?.plugins.map((p: any) =>
							h(TableRow, {
								key: p.id,
								icon: icon(p.icon, 'PuzzlePieceIcon'),
								label: p.name,
								subLabel: [p.description, p.author && `By ${p.author}`].filter(Boolean).join('\n'),
								subLabelLineClamp: 4,
								trailing: p.version && h(TableRow.TrailingText, { text: p.version }),
							}),
						),
					),
		]
	} else {
		body = h(
			TableRowGroup,
			{ title: 'Repositories', description: `${REPOS.length} repositories` },
			REPOS.map(e => {
				const r = cache.get(e.url)
				return h(TableRow, {
					key: e.url,
					icon: icon(repoIcon(r, e)),
					label: r?.name ?? e.url,
					subLabel: r ? (r.err ? `Failed: ${r.err}` : r.description || e.url) : 'Loading...',
					labelLineClamp: 1,
					subLabelLineClamp: 2,
					trailing: r && !r.err && h(TableRow.TrailingText, { text: String(r.plugins.length) }),
					arrow: true,
					onPress: () => setOpen(e),
				})
			}),
		)
	}

	return h(ScrollView, { style: { flex: 1 } }, h(Stack, { spacing: 16, style: { padding: 16 } }, body))
}

export default plugin({
	SettingsComponent: Browser,
	start({ cleanup, plugin }) {
		if (plugin.startedLate) plugin.requireReload()

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
