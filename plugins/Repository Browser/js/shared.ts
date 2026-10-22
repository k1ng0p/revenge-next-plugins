import { getAssetIdByName } from '@revenge-mod/assets'
import { AlertActionCreators } from '@revenge-mod/discord/actions'
import { Design } from '@revenge-mod/discord/design'
import { callNativeMethod } from '@revenge-mod/modules/native'
import { React, ReactNative } from '@revenge-mod/react'

export type AlertMode = 'all' | 'news' | 'updates' | 'off'

export type Repo = { url: string; source?: string; discord?: string; badges?: string[] }

export type ListedPlugin = {
	id: string
	name: string
	description?: string
	author?: string
	icon?: string
	version?: string
	size?: number
	requires?: string[]
	contributors?: string[]
	discord?: string[]
}

export type Listing = {
	name: string
	description?: string
	icon?: string
	plugins: ListedPlugin[]
	at?: number
	saved?: number
	stale?: string
	err?: string
}

export type PluginRef = { type: 'channel'; channel: string } | { type: 'version'; version: string }

export type RepoListing = {
	id: string
	name: string
	description: string
	author: string
	contributors?: string[]
	icon: string | null
	channels: Record<string, string>
	order: string[]
	versions: Record<string, { size: number }>
}

export type AvailableUpdate = { id: string; installed: string; available: string; channel: string; repo: string }

export type RevengeRepo = { url: string; enabled: boolean; internal?: boolean }

// the repository list lives on GitHub so it can change without a plugin update
export const REMOTE_LIST =
	'https://raw.githubusercontent.com/k1ng0p/revenge-next-plugins/refs/heads/main/plugins/Repository%20Browser/js/plugin-browser-repos.json'

export const KEY = 'RepositoryBrowser'
export const DAY = 24 * 60 * 60 * 1000
export const AVATAR_SIZE = 32
export const AVATAR_TTL = 10 * 60 * 1000
export const POLL_INTERVAL = 15 * 60 * 1000
export const RECHECK_AFTER_FOCUS = 5 * 60 * 1000
export const MAX_REQUESTS = 4
export const PAGE_SIZE = 30

export const ICON_SLOT = 28
export const ICON_GAP = 8
export const ICON_INDENT = ICON_SLOT + ICON_GAP

export const SORTS = {
	default: 'Default',
	name: 'A-Z',
	updated: 'Recently updated',
	newest: 'Newest',
	installed: 'Installed first',
}

export type SortKey = keyof typeof SORTS

export const ALERT_MODES: Record<AlertMode, { button: string; summary: string }> = {
	all: { button: 'New plugins and updates', summary: 'New plugins and updates to your plugins' },
	news: { button: 'New plugins only', summary: 'New plugins only' },
	updates: { button: 'Updates to my plugins', summary: 'Only updates to your plugins' },
	off: { button: 'Off', summary: 'Off' },
}

export const NOTICE =
	'The repositories listed here are made by the community and are not reviewed by Revenge or Discord. A plugin can access your account and run code inside this app. Only install plugins from authors you trust, read the source before you install, and use them at your own risk.'

export const slash = (url: string) => url.replace(/\/*$/, '/')
export const sleep = (ms: number) => new Promise(done => setTimeout(done, ms))
export const isRemote = (value?: string): value is string => !!value && /^https:/.test(value)
export const errorMessage = (e: any): string => e?.message ?? String(e)
export const hostOf = (url: string) => url.match(/^https:\/\/([^/]+)/)?.[1] ?? url
export const asObject = (value: any): Record<string, any> => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})
export const friendlyError = (err: string) => (/network request failed/i.test(err) ? "Couldn't connect to this repository" : err)
export function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ago(time: number) {
	const minutes = Math.floor((Date.now() - time) / 60000)
	if (minutes < 1) return 'just now'
	if (minutes < 60) return `${minutes}m ago`
	if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
	return `${Math.floor(minutes / 1440)}d ago`
}

let reporter: (error: unknown) => void = () => {}

export const bindReporter = (report: (error: unknown) => void) => {
	reporter = report
}

export const reportError = (error: unknown) => reporter(error)

// newer Revenge wraps replies as { result } or { error }, older builds return the value itself
let wrapped = false
let probed = false

export async function native(name: string, args: unknown[] = []) {
	const reply = await (callNativeMethod as any)(name, args)
	probed = true

	const keys = reply && typeof reply === 'object' && !Array.isArray(reply) ? Object.keys(reply) : []
	if (keys.length === 1 && keys[0] === 'result') {
		wrapped = true
		return reply.result
	}
	if (keys.length === 1 && keys[0] === 'error') {
		wrapped = true
		const { message, code, details } = reply.error ?? {}
		throw Object.assign(new Error(message ?? code ?? 'Unknown error'), { code, details })
	}
	return reply
}

// the reply shape is only known after the first call, so make one if nothing has been sent yet
export async function usesEnvelope() {
	if (!probed) await native('revenge.plugins.repos.list').catch(() => {})
	return wrapped
}

export const h = (...args: any[]) => (React.createElement as any)(...args)

export const asset = (name?: string) => (name ? getAssetIdByName(name) : undefined)

export function icon(value?: string, fallback = 'ListViewIcon') {
	if (isRemote(value)) return h(ReactNative.Image, { source: { uri: value }, style: { width: 24, height: 24, borderRadius: 12 } })
	return h(Design.TableRow.Icon, { source: asset(value) ?? asset(fallback) ?? asset('ic_browse_channel') })
}

export function modal(title: string, content: string, actions: (button: any) => any[], onDismiss?: () => void) {
	const { AlertModal, AlertActionButton, Text } = Design
	AlertActionCreators.openAlert(
		`plugin-browser-${title}`,
		h(AlertModal, {
			title,
			content: h(Text, { color: 'text-default' }, content),
			actions: h(React.Fragment, null, ...actions(AlertActionButton)),
		}),
		onDismiss,
	)
}

export const inform = (title: string, text: string) => modal(title, text, Button => [h(Button, { key: 'ok', text: 'OK', variant: 'secondary' })])

export const showError = (e: unknown) => inform('Plugin Browser', errorMessage(e).split('\n')[0])

export function fail(e: unknown) {
	reportError(e)
	showError(e)
}

export const askReload = (text: string) =>
	modal('Reload required', text, Button => [
		h(Button, { key: 'reload', text: 'Reload', variant: 'primary', onPress: () => native('revenge.app.reload') }),
		h(Button, { key: 'later', text: 'Later', variant: 'secondary' }),
	])

export const confirm = (title: string, text: string, label = 'Install', variant = 'primary') =>
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

// icon and title share a fixed-width slot so the text below lines up with the title
export const iconSlot = (content: any) => h(ReactNative.View, { style: { width: ICON_SLOT, alignItems: 'center', justifyContent: 'center', marginRight: ICON_GAP } }, content)

const parseVersion = (value: string) => value.split('.').map(part => parseInt(part, 10) || 0)

function compareVersions(a: number[], b: number[]) {
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const diff = (a[index] ?? 0) - (b[index] ?? 0)
		if (diff) return diff
	}
	return 0
}

// ranges this doesn't understand count as satisfied, so a warning only shows when it is certain
export function satisfiesRange(version: string, range: string) {
	const current = parseVersion(version)
	return range.split('||').some(set =>
		set
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.every(token => {
				const match = token.match(/^(>=|<=|>|<|=)?v?(\d+(?:\.\d+)*)$/)
				if (!match) return true
				const diff = compareVersions(current, parseVersion(match[2]))
				if (match[1] === '>=') return diff >= 0
				if (match[1] === '<=') return diff <= 0
				if (match[1] === '>') return diff > 0
				if (match[1] === '<') return diff < 0
				return diff === 0
			}),
	)
}

export function compatibilityWarning(plugin: ListedPlugin, discord?: string, blocked?: string) {
	if (blocked) return blocked
	const ranges = plugin.discord
	if (!ranges?.length || !discord) return undefined
	return ranges.some(range => satisfiesRange(discord, range)) ? undefined : `No version of Discord matching ${ranges[0]} is available`
}
