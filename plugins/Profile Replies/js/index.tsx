import {
	ActionSheetActionCreators,
	ActionSheetActionCreatorsModuleId,
	AlertActionCreators,
	ToastActionCreators,
} from '@revenge-mod/discord/actions'
import { Design } from '@revenge-mod/discord/design'
import { Stores } from '@revenge-mod/discord/flux'
import { getModules, lookupModule } from '@revenge-mod/modules/finders'
import {
	withDependencies,
	withName,
	withProps,
} from '@revenge-mod/modules/finders/filters'
import { instead } from '@revenge-mod/patcher'
import { lookupGeneratedIconComponent } from '@revenge-mod/utils/discord'
import { cloneElement, createElement, isValidElement } from 'react'
import { StyleSheet, View } from 'react-native'
import ReplyModal from './reply-modal'
import SettingsComponent from './settings'
import type { ComponentProps, FC, ReactElement } from 'react'
import type { StyleProp, ViewStyle } from 'react-native'

export interface Settings {
	bio: boolean
}

const DefaultSettings: Settings = {
	bio: true,
}

const ALERT_KEY = 'k1ngop.reply-to-status'
const CUSTOM_STATUS = 4
const MENU_CLOSE_MS = 350

const VERBS = {
	reply: 'Replied to',
	react: 'Reacted to',
}

type Kind = keyof typeof VERBS

interface Target {
	userId: string
	subject: 'status' | 'bio'
	text: string
}

interface StatusActivity {
	type?: number
	state?: string
	emoji?: { id?: string; name?: string } | null
}

interface StatusPillProps {
	customStatusActivity?: StatusActivity
}

interface BioTextProps {
	bio?: string
	userId?: string
}

type Pill<P> = (
	props: P,
) => ReactElement<{ style?: StyleProp<ViewStyle> }> | null

interface EmojiSelection {
	surrogates?: string
	id?: string
	name?: string
	animated?: boolean
}

interface PresenceStore {
	getActivities(userId: string): StatusActivity[]
}

interface RelationshipStore {
	getFriendIDs(): string[]
}

interface UserStore {
	getUser(id: string): { globalName?: string; username?: string } | undefined
}

interface MessageActions {
	sendMessage(
		channelId: string,
		message: object,
		waitForChannelReady?: boolean,
		extra?: object,
	): Promise<{ ok?: boolean; status?: number; body?: unknown } | undefined>
}

interface ChannelActions {
	ensurePrivateChannel(userId: string): Promise<string | { id: string }>
}

interface EmojiPicker {
	openEmojiPickerActionSheet(options: {
		onPressEmoji(selection: EmojiSelection): void
		pickerIntention: number
		reactionType: number
		analyticsObject: string
	}): void
}

// The status bubble offsets itself with its own root style. Keeping that on the
// anchor instead lets the menu open on the visible pill and not on the space around it.
const PLACEMENT_KEYS = new Set([
	'margin',
	'marginLeft',
	'marginRight',
	'marginTop',
	'marginBottom',
	'marginHorizontal',
	'marginVertical',
	'marginStart',
	'marginEnd',
	'position',
	'left',
	'right',
	'top',
	'bottom',
	'alignSelf',
	'transform',
])

// Unicode picks carry `surrogates`, custom ones come as `id`, `name` and `animated`.
// The picker suffixes duplicate emoji names with `~n`, which breaks the mention.
function emojiText({ surrogates, id, name, animated }: EmojiSelection) {
	if (surrogates) return surrogates
	if (id && name)
		return `<${animated ? 'a' : ''}:${name.replace(/~\d+$/, '')}:${id}>`
}

// Server emoji don't render in a quote, so only Unicode emoji are kept.
function statusText({ emoji, state }: StatusActivity) {
	const unicode = emoji && !emoji.id ? (emoji.name ?? '') : ''

	return `${unicode} ${state ?? ''}`.trim().replace(/\r?\n/g, ' ')
}

// Bios pad themselves with invisible characters and blank lines to line up their layout,
// and server emoji don't render in a quote, so both are dropped.
function bioText(bio: string) {
	return bio
		.replace(/<a?:\w+:\d+>/g, '')
		.replace(/[\u00A0\u115F\u1160\u200B\u2060\u2800\u3164]/g, ' ')
		.split(/\r?\n/)
		.map(line => line.replace(/\s+/g, ' ').trim())
		.filter(Boolean)
		.join('\n')
}

// Discord epoch is 2015-01-01
const snowflake = () => (BigInt(Date.now() - 1420070400000) << 22n).toString()

function anchorFor(el: ReturnType<Pill<never>> & object, ref: unknown) {
	const style = (StyleSheet.flatten(el.props.style) ?? {}) as Record<
		string,
		unknown
	>
	const outer: Record<string, unknown> = { alignSelf: 'flex-start' }
	const inner: Record<string, unknown> = {}

	for (const key in style)
		(PLACEMENT_KEYS.has(key) ? outer : inner)[key] = style[key]

	return (
		<View
			ref={ref as never}
			collapsable={false}
			pointerEvents="box-only"
			style={outer}
		>
			{cloneElement(el, { style: inner })}
		</View>
	)
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: {
		load: true,
		default: DefaultSettings,
	},
	start({ cleanup, jsonStorage: storage, plugin }) {
		const refs: {
			presence?: PresenceStore
			friends?: RelationshipStore
			messages?: MessageActions
			channels?: ChannelActions
			picker?: EmojiPicker
		} = {}

		cleanup(
			getModules(withProps<PresenceStore>('getActivities'), m => {
				refs.presence ??= m
			}),
			getModules(withProps<RelationshipStore>('getFriendIDs'), m => {
				refs.friends ??= m
			}),
			getModules(
				withProps<MessageActions>('sendMessage', 'receiveMessage'),
				m => {
					refs.messages ??= m
				},
			),
			getModules(withProps<ChannelActions>('ensurePrivateChannel'), m => {
				refs.channels ??= m
			}),
		)

		// Loaded on first use. The picker is found through the modules it sits between.
		function resolvePicker() {
			const { ordered, relative } = withDependencies

			refs.picker ??= lookupModule(
				withDependencies<EmojiPicker>(
					ordered([
						relative(1),
						ActionSheetActionCreatorsModuleId,
						relative(2),
					]),
				).and(withProps('openEmojiPickerActionSheet')),
				{ initialize: true },
			)[0]

			return refs.picker
		}

		const ownerOf = (activity: StatusActivity) =>
			refs.friends
				?.getFriendIDs()
				.find(id =>
					refs.presence
						?.getActivities(id)
						?.some(a => a.type === CUSTOM_STATUS && a === activity),
				)

		const nameOf = (userId: string) => {
			const user = (Stores.UserStore as unknown as UserStore).getUser(userId)

			return user?.globalName || user?.username || 'user'
		}

		async function send(target: Target, kind: Kind, body: string) {
			try {
				const { channels, messages } = refs

				if (!channels || !messages)
					throw new Error(
						`Missing Discord module: ${channels ? 'sendMessage' : 'ensurePrivateChannel'}`,
					)

				const dm = await channels.ensurePrivateChannel(target.userId)
				const quote = target.text.replace(/\r?\n/g, '\n> ')
				const res = await messages.sendMessage(
					typeof dm === 'string' ? dm : dm.id,
					{
						content: `> -# *${VERBS[kind]} ${nameOf(target.userId)}'s ${target.subject}*\n> ${quote}\n${body}`,
						tts: false,
						invalidEmojis: [],
						validNonShortcutEmojis: [],
					},
					true,
					{ nonce: snowflake() },
				)

				if (res?.ok === false)
					throw new Error(
						`Send failed (${res.status}): ${JSON.stringify(res.body)}`,
					)

				ToastActionCreators.open(ALERT_KEY, {
					text: kind === 'reply' ? 'Reply sent' : 'Reaction sent',
				})
			} catch (e) {
				plugin.reportError(e)
			}
		}

		function openReply(target: Target) {
			AlertActionCreators.openAlert(
				ALERT_KEY,
				<ReplyModal
					name={nameOf(target.userId)}
					subject={target.subject}
					quote={target.text}
					onCancel={() => AlertActionCreators.dismissAlert(ALERT_KEY)}
					onSend={reply => {
						AlertActionCreators.dismissAlert(ALERT_KEY)
						send(target, 'reply', reply)
					}}
				/>,
			)
		}

		function openReact(target: Target) {
			try {
				const picker = resolvePicker()

				if (!picker) throw new Error('Missing Discord module: emoji picker')

				picker.openEmojiPickerActionSheet({
					onPressEmoji: selection => {
						const emoji = selection && emojiText(selection)

						if (!emoji)
							return ToastActionCreators.open(ALERT_KEY, {
								text: 'This emoji is not supported',
							})

						ActionSheetActionCreators.hideActionSheet()
						send(target, 'react', emoji)
					},
					pickerIntention: 0,
					reactionType: 0,
					analyticsObject: 'Message',
				})
			} catch (e) {
				plugin.reportError(e)
			}
		}

		// The menu hides action sheets as it closes, so the picker has to wait for it.
		let pendingReact: ReturnType<typeof setTimeout> | undefined

		cleanup(() => clearTimeout(pendingReact))

		let ReactionIcon: ReturnType<typeof lookupGeneratedIconComponent>
		let ReplyIcon: ReturnType<typeof lookupGeneratedIconComponent>

		// triggerOnTap is missing from ContextMenuProps but supported by the menu.
		function TargetMenu({
			target,
			triggerOnLongPress,
			children,
		}: {
			target: Target
			triggerOnLongPress?: boolean
			children: ComponentProps<typeof Design.ContextMenu>['children']
		}) {
			const { ContextMenu: Menu } = Design as {
				ContextMenu: FC<
					ComponentProps<typeof Design.ContextMenu> & {
						triggerOnTap?: boolean
						triggerOnLongPress?: boolean
					}
				>
			}

			ReactionIcon ??= lookupGeneratedIconComponent('ReactionIcon')
			ReplyIcon ??= lookupGeneratedIconComponent('ArrowAngleLeftUpIcon')

			return (
				<Menu
					title={`${nameOf(target.userId)}'s ${target.subject}`}
					items={[
						{
							label: 'React',
							IconComponent: ReactionIcon,
							action: () => {
								clearTimeout(pendingReact)
								pendingReact = setTimeout(
									() => openReact(target),
									MENU_CLOSE_MS,
								)
							},
						},
						{
							label: 'Reply',
							IconComponent: ReplyIcon,
							action: () => openReply(target),
						},
					]}
					triggerOnTap={!triggerOnLongPress}
					triggerOnLongPress={triggerOnLongPress}
				>
					{children}
				</Menu>
			)
		}

		// Renders the client's own pill inside the menu anchor, like Permission Viewer does with role pills.
		function StatusPillWithMenu({
			Pill,
			...props
		}: StatusPillProps & { Pill: Pill<StatusPillProps> }) {
			const el = Pill(props)
			const activity = props.customStatusActivity
			const userId = activity && ownerOf(activity)

			if (!isValidElement(el) || !activity || !userId) return el

			return (
				<TargetMenu
					target={{ userId, subject: 'status', text: statusText(activity) }}
				>
					{({ ref }) => anchorFor(el, ref)}
				</TargetMenu>
			)
		}

		function BioTextWithMenu({
			Pill,
			...props
		}: BioTextProps & { Pill: Pill<BioTextProps> }) {
			const el = Pill(props)
			const { bio, userId } = props
			const text = bio && bioText(bio)

			if (
				!isValidElement(el) ||
				!text ||
				!userId ||
				!(storage.cache?.bio ?? DefaultSettings.bio) ||
				!refs.friends?.getFriendIDs().includes(userId)
			)
				return el

			return (
				<TargetMenu
					target={{ userId, subject: 'bio', text }}
					triggerOnLongPress
				>
					{({ ref }) => anchorFor(el, ref)}
				</TargetMenu>
			)
		}

		function patchDefault<P extends object>(
			name: string,
			Wrapper: FC<P & { Pill: Pill<P> }>,
		) {
			cleanup(
				getModules(
					withName<Pill<P>>(name),
					module => {
						const namespace = module as unknown as { default?: Pill<P> }

						if (typeof namespace?.default !== 'function')
							return plugin.reportError(
								new Error(
									`${name} has no default export, the menu cannot be installed.`,
								),
							)

						cleanup(
							instead(
								namespace as { default: Pill<P> },
								'default',
								(args, original) =>
									createElement(Wrapper, {
										...args[0],
										Pill: original,
									} as P & { Pill: Pill<P> }),
							),
						)
					},
					{ returnNamespace: true },
				),
			)
		}

		patchDefault('UserProfileCustomStatusBubble', StatusPillWithMenu)
		patchDefault('BioText', BioTextWithMenu)
	},
	SettingsComponent,
})