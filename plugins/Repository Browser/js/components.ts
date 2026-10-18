import { Design } from '@revenge-mod/discord/design'
import { React, ReactNative } from '@revenge-mod/react'
import { cachedAvatar, catalog, discordUser, githubAvatar, newRepoCount, parseAuthor, unreadCount, useStore } from './data'
import { AVATAR_SIZE, NOTICE, asset, h, icon, inform, isRemote } from './shared'
import type { ListedPlugin, Listing, Repo } from './shared'
export type CardUpdate = { from: string; to: string; state: 'ready' | 'busy' | 'pending'; onPress: () => void }

export function RepoAvatar({ repo, listing, epoch, person }: { repo: Repo; listing?: Listing; epoch: number; person?: boolean }) {
	const { Image, View } = ReactNative
	const [discordUrl, setDiscordUrl] = React.useState<string | null>(() => (repo.discord ? cachedAvatar(repo.discord) : null))
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

export function PluginCard(props: { plugin: ListedPlugin; version?: string; origin?: string; actions: any[]; update?: CardUpdate; onPress?: () => void }) {
	const { plugin, version, origin, actions, update, onPress } = props
	const { Pressable, View } = ReactNative
	const { Button, Card, Text } = Design
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
					h(Text, { color: 'text-muted', variant: 'heading-md/medium' }, `by ${parseAuthor(plugin.author).name}${version ? ` \u2022 ${version}` : ''}`),
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

export function Notice() {
	const { View } = ReactNative
	const { Card, IconButton, Text } = Design
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

export function FeedSection(props: { title: string; action?: string; variant?: string; loading?: boolean; onAction: () => void; children: any }) {
	const { title, action = 'Clear', variant = 'tertiary', loading, onAction, children } = props
	const { View } = ReactNative
	const { Button, Text } = Design
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

export function RepoCount() {
	const { View } = ReactNative
	const { Text } = Design
	const data = useStore()
	const unread = unreadCount(data, catalog)
	const fresh = newRepoCount(data, catalog)

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

const BADGE_COLORS: Record<string, string> = {
	official: '#5865F2',
	developer: '#5865F2',
	verified: '#248046',
	trusted: '#248046',
	reviewed: '#248046',
	popular: '#8E44AD',
	new: '#EB459E',
	beta: '#C77D0A',
	unmaintained: '#C77D0A',
	caution: '#DA373C',
	deprecated: '#DA373C',
}

export function RepoBadges({ badges }: { badges: string[] }) {
	const { View } = ReactNative
	const { Text } = Design
	return h(
		View,
		{ style: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end' } },
		...badges.map(label =>
			h(
				View,
				{ key: label, style: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, marginLeft: 4, marginBottom: 4, backgroundColor: BADGE_COLORS[label.toLowerCase()] ?? '#4E5058' } },
				h(Text, { variant: 'text-xs/bold', style: { color: '#FFFFFF' } }, label),
			),
		),
	)
}
