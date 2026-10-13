import { getModules } from '@revenge-mod/modules/finders'
import { withProps } from '@revenge-mod/modules/finders/filters'
import { after, instead } from '@revenge-mod/patcher'
import { cloneElement, createElement, isValidElement } from 'react'
import type { FC, MemoExoticComponent, ReactElement, ReactNode } from 'react'

interface Channel {
	name?: string
}

interface RowProps {
	channel?: Channel | null
}

type TextChannel = MemoExoticComponent<FC<RowProps>>

const renamed = new WeakMap<Channel, Channel>()
const wrapped = new WeakMap<FC<any>, FC<any>>()

const dashless = (channel: Channel) => {
	if (!channel.name?.includes('-')) return channel

	const copy: Channel =
		renamed.get(channel) ??
		Object.create(channel, { name: { value: channel.name.replace(/-/g, ' ') } })
	renamed.set(channel, copy)
	return copy
}

const wrapThread = (Thread: FC<any>) => {
	let Wrapped = wrapped.get(Thread)
	if (!Wrapped) {
		Wrapped = props => {
			const tree = Thread(props)
			return isValidElement<RowProps>(tree) && tree.props.channel
				? cloneElement(tree, { channel: dashless(tree.props.channel) })
				: tree
		}
		wrapped.set(Thread, Wrapped)
	}
	return Wrapped
}

const isRow = (el: ReactElement<any>) =>
	'isSuggestedSection' in el.props &&
	el.props.channel != null &&
	typeof (el.type as { type?: unknown })?.type === 'function'

const isThread = (el: ReactElement<any>) =>
	'threadId' in el.props && !('channel' in el.props) && typeof el.type === 'function'

const findRow = (node: ReactNode): ReactElement | undefined => {
	if (Array.isArray(node)) return node.map(findRow).find(Boolean)
	if (!isValidElement<{ children?: ReactNode }>(node)) return
	return isRow(node) ? node : findRow(node.props.children)
}

const swapThreads = (node: ReactNode): ReactNode => {
	if (Array.isArray(node)) return node.map(swapThreads)
	if (!isValidElement<{ children?: ReactNode }>(node)) return node
	if (isThread(node))
		return createElement(wrapThread(node.type as FC<any>), { key: node.key, ...node.props })
	if (!node.props.children) return node

	const children = swapThreads(node.props.children)
	return Array.isArray(children)
		? cloneElement(node, undefined, ...children)
		: cloneElement(node, undefined, children)
}

export default plugin({
	start({ cleanup, plugin }) {
		if (plugin.startedLate) {
			plugin.requireReload()
			return
		}

		let rowPatched = false

		cleanup(
			// modules/channel_list_v2/native/renderRedesignChannelListItem.tsx
			getModules(
				withProps<{ renderChannelListItem(...args: any[]): ReactNode }>(
					'renderChannelListItem',
				),
				ChannelListItem => {
					cleanup(
						after(ChannelListItem, 'renderChannelListItem', tree => {
							const row = rowPatched ? undefined : findRow(tree)
							if (row) {
								rowPatched = true
								cleanup(
									instead(row.type as TextChannel, 'type', ([props], orig) =>
										orig({ ...props, channel: props.channel && dashless(props.channel) }),
									),
								)
							}

							return swapThreads(tree)
						}),
					)
				},
			),
		)
	},
	stop({ plugin }) {
		plugin.requireReload()
	},
})
