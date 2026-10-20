import {
	AlertActionCreators,
	ToastActionCreators,
} from '@revenge-mod/discord/actions'
import { Stores } from '@revenge-mod/discord/flux'
import { getModules } from '@revenge-mod/modules/finders'
import { withName, withProps } from '@revenge-mod/modules/finders/filters'
import { afterJSX } from '@revenge-mod/react/jsx-runtime'
import { Pressable } from 'react-native'
import ReplyModal from './reply-modal'
import type { ComponentType } from 'react'

const DEBUG: boolean = false

const ALERT_KEY = 'k1ngop.reply-to-status'
const CUSTOM_STATUS = 4

interface StatusActivity {
	type?: number
	state?: string
	emoji?: { id?: string; name?: string } | null
}

interface BubbleProps {
	customStatusActivity?: StatusActivity
}

// Discord epoch is 2015-01-01; the nonce only needs to be a unique snowflake.
const snowflake = () => (BigInt(Date.now() - 1420070400000) << 22n).toString()

// Custom (server) emoji can't be rendered reliably in a quote, so only Unicode emoji are kept.
function statusText({ emoji, state }: StatusActivity) {
	const unicode = emoji && !emoji.id ? (emoji.name ?? '') : ''

	return `${unicode} ${state ?? ''}`.trim().replace(/\r?\n/g, ' ')
}

export default plugin({
	start({ cleanup, plugin: self }) {
		const refs: {
			presence?: { getActivities(id: string): StatusActivity[] }
			friends?: { getFriendIDs(): string[] }
			messages?: {
				sendMessage(
					channelId: string,
					message: object,
					waitForChannelReady?: boolean,
					extra?: object,
				): Promise<unknown>
				receiveMessage: unknown
			}
			channels?: {
				ensurePrivateChannel(userId: string): Promise<string | { id: string }>
			}
		} = {}

		cleanup(
			getModules(
				withProps<NonNullable<typeof refs.presence>>('getActivities'),
				m => {
					refs.presence ??= m
				},
			),
			getModules(
				withProps<NonNullable<typeof refs.friends>>('getFriendIDs'),
				m => {
					refs.friends ??= m
				},
			),
			getModules(
				withProps<NonNullable<typeof refs.messages>>(
					'sendMessage',
					'receiveMessage',
				),
				m => {
					refs.messages ??= m
				},
			),
			getModules(
				withProps<NonNullable<typeof refs.channels>>('ensurePrivateChannel'),
				m => {
					refs.channels ??= m
				},
			),
		)

		const ownerOf = (act: StatusActivity) =>
			refs.friends
				?.getFriendIDs()
				.find(id =>
					refs.presence
						?.getActivities(id)
						?.some(a => a.type === CUSTOM_STATUS && a === act),
				)

		async function send(
			userId: string,
			name: string,
			act: StatusActivity,
			reply: string,
		) {
			try {
				const quoted = statusText(act)
				const content = `> -# *replied to ${name}'s status*\n> ${quoted}\n${reply}`
				const { channels, messages } = refs

				if (!channels || !messages)
					throw new Error(
						`Missing Discord module: ${channels ? 'sendMessage' : 'ensurePrivateChannel'}`,
					)

				const dm = await channels.ensurePrivateChannel(userId)

				const res = (await messages.sendMessage(
					typeof dm === 'string' ? dm : dm.id,
					{
						content,
						tts: false,
						invalidEmojis: [],
						validNonShortcutEmojis: [],
					},
					true,
					{ nonce: snowflake() },
				)) as { ok?: boolean; status?: number; body?: unknown } | undefined

				if (DEBUG) console.log('[reply-to-status]', dm, res)

				if (res && res.ok === false)
					throw new Error(
						`Send failed (${res.status}): ${JSON.stringify(res.body)}`,
					)

				ToastActionCreators.open(ALERT_KEY, { text: 'Reply sent' })
			} catch (e) {
				self.reportError(e)
			}
		}

		function openReply(userId: string, act: StatusActivity) {
			const user = (
				Stores.UserStore as unknown as {
					getUser(
						id: string,
					): { globalName?: string; username?: string } | undefined
				}
			)?.getUser(userId)
			const name = user?.globalName || user?.username || 'user'

			if (DEBUG) console.log('[reply-to-status]', userId, name)

			AlertActionCreators.openAlert(
				ALERT_KEY,
				<ReplyModal
					name={name}
					status={statusText(act)}
					onCancel={() => AlertActionCreators.dismissAlert(ALERT_KEY)}
					onSend={reply => {
						AlertActionCreators.dismissAlert(ALERT_KEY)
						send(userId, name, act, reply)
					}}
				/>,
			)
		}

		cleanup(
			getModules(
				withName<ComponentType<BubbleProps>>('UserProfileCustomStatusBubble'),
				Bubble => {
					cleanup(
						afterJSX(Bubble, el => {
							try {
								const act = el.props.customStatusActivity
								const userId = act && ownerOf(act)

								if (!act || !userId) return el

								return (
									<Pressable
										style={{ alignSelf: 'flex-start' }}
										onPress={() => openReply(userId, act)}
									>
										{el}
									</Pressable>
								)
							} catch (e) {
								self.reportError(e)
								return el
							}
						}),
					)
				},
			),
		)
	},
})
