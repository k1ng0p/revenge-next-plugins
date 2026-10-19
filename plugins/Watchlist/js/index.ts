import { ToastActionCreators } from '@revenge-mod/discord/actions'
import { onFluxEventDispatched, Stores } from '@revenge-mod/discord/flux'
import SettingsComponent from './settings'
import type { DiscordModules } from '@revenge-mod/discord/types'
import type { JsonStorage } from '@revenge-mod/json-storage'

const DEBUG: boolean = false

export interface Settings {
	/** IDs of the users on the watchlist. */
	users: string[]
	status: boolean
	typing: boolean
	messages: boolean
}

export const DefaultSettings: Settings = {
	users: [],
	status: true,
	typing: true,
	messages: true,
}

const ChannelType = { DM: 1, GroupDM: 3 } as const

export interface User {
	id: string
	username: string
	globalName?: string | null
	getAvatarURL?(
		guildId?: string | null,
		size?: number,
		canAnimate?: boolean,
	): string | number
}

interface Channel {
	id: string
	type: number
	name?: string
	recipients?: string[]
}

interface PresenceUpdates {
	updates?: { user?: { id: string }; status: string }[]
}

interface TypingStart {
	channelId: string
	userId: string
}

interface MessageCreate {
	channelId: string
	optimistic?: boolean
	message?: {
		content?: string
		author?: { id: string; username: string; global_name?: string | null }
		attachments?: unknown[]
	}
}

const MaxMessageLength = 120
const SnowflakePattern = /^\d{17,20}$/

const StatusLabels: Record<string, string> = {
	online: 'online',
	idle: 'idle',
	dnd: 'on Do Not Disturb',
	offline: 'offline',
	invisible: 'offline',
}

const getUserStore = () =>
	Stores.UserStore as DiscordModules.Flux.Store<{
		getUser(id: string): User | undefined
		getCurrentUser(): User | undefined
	}>

const getChannelStore = () =>
	Stores.ChannelStore as DiscordModules.Flux.Store<{
		getChannel(id: string): Channel | undefined
	}>

const getPresenceStore = () =>
	Stores.PresenceStore as DiscordModules.Flux.Store<{
		getStatus(userId: string): string
	}>

const getTypingStore = () =>
	Stores.TypingStore as DiscordModules.Flux.Store<{
		getTypingUsers(channelId: string): Record<string, number>
	}>

let logger: DiscordModules.Logger
let storage: JsonStorage<Settings>
let reportError: (error: unknown) => void

let toastCount = 0
// The status each tracked user was last seen with, so one change toasts once
const statuses = new Map<string, string>()

export const getSettings = () =>
	({ ...DefaultSettings, ...storage.cache }) as Settings

export const isTracked = (id: string) => getSettings().users.includes(id)

export function getUserName(id: string) {
	const user = getUserStore().getUser(id)
	return user?.globalName || user?.username || id
}

function showToast(
	text: string,
	userId?: string,
	variant?: 'success' | 'critical',
) {
	const src =
		userId && getUserStore().getUser(userId)?.getAvatarURL?.(null, 64, false)

	// A toast already on screen would hold this one back
	ToastActionCreators.close()
	ToastActionCreators.open(`watchlist-${++toastCount}`, {
		text,
		variant,
		icon:
			userId && typeof src === 'string'
				? { type: 'avatar', src, alt: getUserName(userId) }
				: undefined,
	})
}

export async function trackUser(userId: string) {
	if (!SnowflakePattern.test(userId)) {
		showToast('Enter a valid user ID', undefined, 'critical')
		return false
	}

	const { users } = getSettings()
	if (users.includes(userId)) {
		showToast(`${getUserName(userId)} is already on your Watchlist`, userId)
		return false
	}

	await storage.set({ ...getSettings(), users: [...users, userId] }, true)
	showToast(`Added ${getUserName(userId)} to your Watchlist`, userId, 'success')

	return true
}

export async function untrackUser(userId: string) {
	statuses.delete(userId)

	const settings = getSettings()
	await storage.set(
		{ ...settings, users: settings.users.filter(id => id !== userId) },
		true,
	)
	showToast(`Removed ${getUserName(userId)} from your Watchlist`, userId)
}

function describeChannel(channel?: Channel) {
	if (!channel) return 'a channel'
	if (channel.type === ChannelType.DM) return 'DM'
	if (channel.type === ChannelType.GroupDM) return channel.name || 'Group DM'
	return `#${channel.name}`
}

function onPresence({ updates }: PresenceUpdates) {
	if (!getSettings().status) return

	for (const update of updates ?? []) {
		const userId = update.user?.id
		if (!userId || !isTracked(userId)) continue

		// Dispatch hooks run before the store updates, so the store still holds the old status
		const previous =
			statuses.get(userId) ?? getPresenceStore().getStatus(userId)
		statuses.set(userId, update.status)
		if (previous === update.status) continue

		showToast(
			`${getUserName(userId)} is now ${StatusLabels[update.status] ?? update.status}`,
			userId,
		)
	}
}

function onTyping({ channelId, userId }: TypingStart) {
	if (!getSettings().typing || !isTracked(userId)) return

	// Discord repeats this event while someone types. The store only forgets them once they stop or send, so a new session toasts again.
	const typing = userId in getTypingStore().getTypingUsers(channelId)
	if (DEBUG) logger.log('typing', userId, channelId, typing)
	if (typing) return

	showToast(
		`${getUserName(userId)} is typing in ${describeChannel(getChannelStore().getChannel(channelId))}`,
		userId,
	)
}

function onMessage({ channelId, optimistic, message }: MessageCreate) {
	const author = message?.author
	if (!getSettings().messages || optimistic || !author || !isTracked(author.id))
		return

	const content = message.content?.trim()
	const text = content
		? content.length > MaxMessageLength
			? `${content.slice(0, MaxMessageLength)}...`
			: content
		: message.attachments?.length
			? 'Sent an attachment'
			: 'Sent a message'

	const name = getUserStore().getUser(author.id)
		? getUserName(author.id)
		: author.global_name || author.username

	showToast(
		`${name} in ${describeChannel(getChannelStore().getChannel(channelId))}: ${text}`,
		author.id,
	)
}

/** Runs a flux handler without ever blocking the event it observes. */
function observe<T extends object>(handler: (payload: T) => void) {
	return (payload: DiscordModules.Flux.DispatcherPayload & T) => {
		try {
			handler(payload)
		} catch (error) {
			reportError(error)
		}

		return payload
	}
}

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: {
		load: true,
		default: DefaultSettings,
	},
	start({ cleanup, jsonStorage, logger: pluginLogger, plugin }) {
		storage = jsonStorage
		logger = pluginLogger
		reportError = error => plugin.reportError(error)

		cleanup(
			onFluxEventDispatched<PresenceUpdates>(
				'PRESENCE_UPDATES',
				observe(onPresence),
			),
			onFluxEventDispatched<TypingStart>('TYPING_START', observe(onTyping)),
			onFluxEventDispatched<MessageCreate>(
				'MESSAGE_CREATE',
				observe(onMessage),
			),
			() => statuses.clear(),
		)
	},
	SettingsComponent,
})
