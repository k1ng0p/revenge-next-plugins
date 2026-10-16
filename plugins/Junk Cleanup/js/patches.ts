import { getAssetIdByName } from '@revenge-mod/assets'
import { ActionSheetActionCreators } from '@revenge-mod/discord/actions'
import { Design } from '@revenge-mod/discord/design'
import { SettingListRenderer } from '@revenge-mod/discord/modules/settings/renderer'
import { getModuleWithImportedPath } from '@revenge-mod/discord/utils/modules/finders'
import { getModules } from '@revenge-mod/modules/finders'
import { withName, withProps } from '@revenge-mod/modules/finders/filters'
import { before, instead } from '@revenge-mod/patcher'
import { ReactJSXRuntime } from '@revenge-mod/react'
import { insteadJSX } from '@revenge-mod/react/jsx-runtime'
import { isOn, ui } from './options'
import type { PluginCleanupApi } from '@revenge-mod/plugins/types'
import type { OptionKey } from './options'

const DEBUG: boolean = false

export interface Env {
	cleanup: PluginCleanupApi
	fail: (error: unknown) => void
	live: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Runs `fn` while the plugin is running, sending failures to `plugin.reportError` */
function safely(env: Env, fn: () => void) {
	if (!env.live) return
	try {
		fn()
	} catch (e) {
		env.fail(e)
	}
}

function whenPath<T = any>(env: Env, path: string, fn: (ns: T) => void) {
	env.cleanup(
		getModuleWithImportedPath<T>(path, (ns: T) => safely(env, () => fn(ns))),
	)
}

function whenNamed<T = any>(env: Env, name: string, fn: (ns: T) => void) {
	env.cleanup(
		getModules(withName(name), (ns: any) => safely(env, () => fn(ns)), {
			returnNamespace: true,
		}),
	)
}

function whenProps<T = any>(env: Env, props: string[], fn: (ns: T) => void) {
	const filter = (
		withProps as (...p: string[]) => ReturnType<typeof withProps>
	)(...props)
	env.cleanup(
		getModules(filter, (ns: any) => safely(env, () => fn(ns)), {
			returnNamespace: true,
		}),
	)
}

/** Swaps `host[key]` so its result passes through `transform` */
function rewrite(
	env: Env,
	host: any,
	key: string,
	transform: (result: any, args: any[]) => any,
) {
	if (typeof host?.[key] !== 'function') return
	env.cleanup(
		instead(host, key, function (this: unknown, args: any[], original: any) {
			return transform(Reflect.apply(original, this, args), args)
		}),
	)
}

/** Renders nothing in place of `target` while the option is on */
function mute(env: Env, target: any, option: OptionKey) {
	if (!target) return
	env.cleanup(
		insteadJSX(target, (args, jsx) =>
			isOn(option) ? null : jsx(args[0], args[1], args[2]),
		),
	)
}

/** A module's component: the default export, or the namespace itself */
function componentOf(ns: any): any {
	const exported = ns?.default ?? ns
	return typeof exported === 'function' ||
		(exported && typeof exported === 'object')
		? exported
		: undefined
}

// ---------------------------------------------------------------------------
// Profiles and chat
// ---------------------------------------------------------------------------

const WISHLIST_TAB_IDS = new Set(['wishlist', 'board', 'activity'])

function profileAndChat(env: Env) {
	const emptyIfOn = (option: OptionKey) => (r: any) => (isOn(option) ? null : r)

	// modules/collectibles/avatar_decorations/*, design/void/Avatar/native/Avatar.tsx
	whenPath(
		env,
		'modules/collectibles/avatar_decorations/useAvatarDecoration.tsx',
		ns => {
			rewrite(env, ns, 'useAvatarDecoration', emptyIfOn('avatarDecorations'))
			rewrite(env, ns, 'getAvatarDecoration', emptyIfOn('avatarDecorations'))
		},
	)
	whenPath(
		env,
		'modules/collectibles/avatar_decorations/AvatarDecorationUtils.tsx',
		ns =>
			rewrite(
				env,
				ns,
				'parseAvatarDecorationData',
				emptyIfOn('avatarDecorations'),
			),
	)
	whenPath(env, 'design/void/Avatar/native/Avatar.tsx', ns => {
		const avatar = componentOf(ns)
		if (!avatar) return
		env.cleanup(
			insteadJSX(avatar, ([type, props, key]: any[], jsx) =>
				isOn('avatarDecorations') && props?.avatarDecoration != null
					? jsx(type, { ...props, avatarDecoration: null }, key)
					: jsx(type, props, key),
			),
		)
	})

	// Nameplates
	whenProps(env, ['useNameplate'], ns =>
		rewrite(env, ns, 'useNameplate', emptyIfOn('nameplates')),
	)
	whenNamed(env, 'Nameplate', ns => mute(env, componentOf(ns), 'nameplates'))

	// Profile effects and frames
	whenNamed(env, 'useProfileEffect', ns =>
		rewrite(env, ns, 'default', emptyIfOn('profileEffects')),
	)
	whenNamed(env, 'WrappedProfileEffect', ns =>
		mute(env, componentOf(ns), 'profileEffects'),
	)
	whenNamed(env, 'useProfileFrame', ns =>
		rewrite(env, ns, 'default', emptyIfOn('profileFrames')),
	)

	// Badges
	whenNamed(env, 'useBadges', ns =>
		rewrite(env, ns, 'default', r => (isOn('badges') ? [] : r)),
	)

	// Server tags: modules/guild_tag/*
	whenPath(env, 'modules/guild_tag/GuildTagUtils.tsx', ns => {
		rewrite(env, ns, 'useShouldDisplayGuildTag', r =>
			isOn('serverTags') ? false : r,
		)
		rewrite(env, ns, 'shouldDisplayGuildTag', r =>
			isOn('serverTags') ? false : r,
		)
		rewrite(env, ns, 'getUserPrimaryGuild', r =>
			isOn('serverTags') && r
				? { ...r, tag: null, badge: null, guildId: null }
				: r,
		)
	})
	whenPath(env, 'modules/guild_tag/native/GuildTag.tsx', ns => {
		for (const target of [
			componentOf(ns),
			ns?.GuildTagBadge,
			ns?.BaseGuildTagChiplet,
		])
			mute(env, target, 'serverTags')
	})
	whenPath(env, 'modules/guild_tag/native/VoiceGuildTag.tsx', ns =>
		mute(env, componentOf(ns), 'serverTags'),
	)

	// Display name styles
	whenNamed(env, 'useDisplayNameStyles', ns =>
		rewrite(env, ns, 'default', emptyIfOn('displayNameStyles')),
	)
	whenNamed(env, 'createMessageContent', ns =>
		rewrite(env, ns, 'default', r =>
			isOn('displayNameStyles') && r?.displayNameStyles != null
				? { ...r, displayNameStyles: null }
				: r,
		),
	)

	// DM happening-now cards
	whenProps(env, ['getMessagesItemHappeningNowHeight'], ns => {
		rewrite(env, ns.default, 'type', emptyIfOn('dmActivityCards'))
		rewrite(env, ns, 'getMessagesItemHappeningNowHeight', r =>
			isOn('dmActivityCards') ? 0 : r,
		)
	})

	// Wishlist and board tabs:
	// design/components/SegmentedControl/native/SegmentedControlState.native.tsx
	// design/components/Tabs/native/Tabs.native.tsx
	whenPath(
		env,
		'design/components/SegmentedControl/native/SegmentedControlState.native.tsx',
		ns => {
			if (typeof ns?.useSegmentedControlState !== 'function') return
			env.cleanup(
				instead(
					ns,
					'useSegmentedControlState',
					(args: any[], original: any) => {
						const items = args[0]?.items
						const affected =
							isOn('wishlist') &&
							Array.isArray(items) &&
							items.some(i => WISHLIST_TAB_IDS.has(i?.id))
						return affected
							? original({
									...args[0],
									items: items.filter((i: any) => !WISHLIST_TAB_IDS.has(i?.id)),
								})
							: original(...args)
					},
				),
			)
		},
	)
	// One tab left makes the whole bar pointless
	whenPath(env, 'design/components/Tabs/native/Tabs.native.tsx', ns => {
		if (typeof ns?.Tabs !== 'function') return
		env.cleanup(
			insteadJSX(ns.Tabs, (args, jsx) => {
				const items = (args[1] as any)?.state?.items
				return isOn('wishlist') && Array.isArray(items) && items.length <= 1
					? null
					: jsx(args[0], args[1], args[2])
			}),
		)
	})
}

// ---------------------------------------------------------------------------
// You tab, quest dock and boost bar
// ---------------------------------------------------------------------------

/** Hides a module's component; `rules` limit it to specific JSX keys */
function muteKeyed(
	env: Env,
	path: string,
	rules: Array<{ jsxKey?: string; option: OptionKey }>,
) {
	whenPath(env, path, ns => {
		const target = componentOf(ns)
		if (!target) return
		env.cleanup(
			insteadJSX(target, (args, jsx) =>
				rules.some(
					r =>
						(r.jsxKey === undefined || args[2] === r.jsxKey) && isOn(r.option),
				)
					? null
					: jsx(args[0], args[1], args[2]),
			),
		)
	})
}

function questsAndShop(env: Env) {
	muteKeyed(env, 'modules/quests/native/QuestDock/QuestDock.tsx', [
		{ option: 'questDock' },
	])
	muteKeyed(env, 'modules/main_tabs_v2/native/tabs/you/YouScreenNavIcon.tsx', [
		{ jsxKey: 'quests', option: 'youQuests' },
		{ jsxKey: 'nitro', option: 'youNitro' },
	])
	muteKeyed(
		env,
		'modules/main_tabs_v2/native/tabs/you/YouScreenNavIconNitroSubscriber.tsx',
		[{ jsxKey: 'nitro-subscriber', option: 'youNitro' }],
	)
	muteKeyed(
		env,
		'modules/collectibles/native/CollectiblesShopEntryButton.tsx',
		[{ jsxKey: 'shop', option: 'youShop' }],
	)
	muteKeyed(env, 'modules/virtual_currency/native/BalanceWidgetMenu.tsx', [
		{ option: 'youOrbs' },
	])

	// modules/guild_sidebar/useGuildActionRows.tsx
	whenPath(env, 'modules/guild_sidebar/useGuildActionRows.tsx', ns =>
		rewrite(env, ns, 'default', rows =>
			isOn('boostGoal') && Array.isArray(rows)
				? rows.filter(row => row !== 'guild-premium-progress-bar')
				: rows,
		),
	)
}

// ---------------------------------------------------------------------------
// Settings page (rows resolved from the settings tree)
// ---------------------------------------------------------------------------

const NITRO_SETTING_KEYS = new Set([
	'PREMIUM',
	'PREMIUM_MANAGE_SUBSCRIPTIONS',
	'PREMIUM_MANAGE_PLAN',
	'PREMIUM_PLAN_SELECT',
	'PREMIUM_GIFTING',
	'PREMIUM_GUILD_BOOSTING',
	'PREMIUM_RESTORE_SUBSCRIPTION',
	'GUILD_ROLE_SUBSCRIPTIONS',
	'GUILD_ROLE_SUBSCRIPTIONS_CANCEL',
	'PREMIUM_PROFILE_CUSTOMIZATION_TRY_IT_OUT',
	'COLLECTIBLES_SHOP',
	'COLLECTIBLES_SHOP_VIEW_ALL_CATEGORY_ITEMS',
	'QUEST_HOME',
	'QUEST_PREVIEW_TOOL',
])

/** Tested against a setting key or section label, upper-cased with `_` separators */
const SETTING_PATTERNS: Array<[OptionKey, RegExp]> = [
	['setFamily', /FAMILY/],
	['setClips', /^CLIPS?$/],
	['setScanQr', /SCAN_?QR/],
	['setSupport', /^(SUPPORT|(UPLOAD_)?DEBUG_LOGS|ACKNOWLEDGE?MENTS)$/],
	['setWhatsNew', /WHATS?_?NEW|CHANGE_?LOG/],
	['setBugReporter', /BUG_?REPORT/],
]

function settingIsHidden(raw: unknown): boolean {
	if (typeof raw !== 'string') return false
	if (isOn('setNitro') && NITRO_SETTING_KEYS.has(raw)) return true
	const text = raw
		.replace(/[\u2018\u2019]/g, '')
		.replace(/'/g, '')
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, '_')
	return SETTING_PATTERNS.some(([option, re]) => isOn(option) && re.test(text))
}

interface SettingsTreeProps {
	node?: {
		sections?: Array<{ label?: unknown; title?: unknown; settings?: string[] }>
	}
}

function pruneTree(props: SettingsTreeProps): SettingsTreeProps {
	const sections = props.node?.sections
	if (!props.node || !Array.isArray(sections)) return props
	if (DEBUG)
		console.log(
			'[junk-cleanup] settings sections',
			sections.map(s => [s.label ?? s.title, s.settings]),
		)

	return {
		...props,
		node: {
			...props.node,
			// A section left without rows goes away together with its header
			sections: sections
				.filter(s => !settingIsHidden(s.label ?? s.title))
				.map(s => ({
					...s,
					settings: s.settings?.filter(k => !settingIsHidden(k)),
				}))
				.filter(s => !s.settings || s.settings.length > 0),
		},
	}
}

function settingsPage(env: Env) {
	for (const list of [
		SettingListRenderer.SettingsList,
		SettingListRenderer.SearchableSettingsList,
	])
		env.cleanup(
			insteadJSX(list as any, ([type, props, key], jsx) =>
				jsx(type, pruneTree(props as SettingsTreeProps), key),
			),
		)

	// Deep links into Nitro and payment screens
	whenPath(
		env,
		'modules/settings/native/renderer/SettingTreeManager.tsx',
		ns => {
			const manager = ns?.default
			if (typeof manager?.isBlocked !== 'function') return
			env.cleanup(
				instead(manager, 'isBlocked', (args: any[], original: any) =>
					isOn('setNitro') && NITRO_SETTING_KEYS.has(args[0])
						? true
						: Reflect.apply(original, manager, args),
				),
			)
		},
	)
}

// ---------------------------------------------------------------------------
// Rows and groups matched by their visible English label
// ---------------------------------------------------------------------------

interface LabelRule {
	option: OptionKey
	/** `message` only applies while the message long-press sheet is open */
	where: 'message' | 'anywhere'
	rows?: readonly string[]
	groups?: readonly string[]
}

const LABEL_RULES: readonly LabelRule[] = [
	{ option: 'msgForward', where: 'message', rows: ['Forward'] },
	{ option: 'msgThread', where: 'message', rows: ['Create Thread'] },
	{ option: 'msgMarkUnread', where: 'message', rows: ['Mark Unread'] },
	{ option: 'msgApps', where: 'message', rows: ['Apps'] },
	{ option: 'msgBookmark', where: 'message', rows: ['Bookmark Message'] },
	{ option: 'msgReminder', where: 'message', rows: ['Create Reminder'] },
	{ option: 'msgDm', where: 'message', rows: ['Message'] },
	{ option: 'msgMention', where: 'message', rows: ['Mention'] },
	{
		option: 'setWhatsNew',
		where: 'anywhere',
		rows: ["What's New"],
		groups: ["What's New"],
	},
	{
		option: 'voiceAddPeople',
		where: 'anywhere',
		rows: ['Add people to Voice Chat', 'Let the group know you are here!'],
	},
	{
		option: 'voiceConsole',
		where: 'anywhere',
		rows: ['Transfer to Xbox', 'Transfer to PlayStation'],
		groups: ['Transfer to Console'],
	},
]

const normalizeLabel = (text: string) =>
	text
		.replace(/[\u2018\u2019]/g, "'")
		.trim()
		.toLowerCase()

function indexBy(field: 'rows' | 'groups') {
	const index = new Map<string, LabelRule>()
	for (const rule of LABEL_RULES)
		for (const label of rule[field] ?? [])
			index.set(normalizeLabel(label), rule)
	return index
}

const ROW_LABELS = indexBy('rows')
const GROUP_LABELS = indexBy('groups')

function ruleApplies(rule: LabelRule): boolean {
	if (ui.settingsOpen || !isOn(rule.option)) return false
	return rule.where === 'anywhere' || ui.messageSheetOpen
}

/** A prop's visible text: a plain string, or an element wrapping one */
function textOfProp(value: unknown): string | undefined {
	if (typeof value === 'string') return value
	const children = (value as { props?: { children?: unknown } } | null)?.props
		?.children
	return typeof children === 'string' ? children : undefined
}

const patchedTargets = new WeakSet<object>()

function muteByLabel(
	env: Env,
	target: unknown,
	index: Map<string, LabelRule>,
	propNames: readonly string[],
) {
	if (!target || patchedTargets.has(target as object)) return
	patchedTargets.add(target as object)
	env.cleanup(
		insteadJSX(target as any, (args, jsx) => {
			const props = args[1] as Record<string, unknown> | undefined
			for (const name of propNames) {
				const text = textOfProp(props?.[name])
				const rule = text ? index.get(normalizeLabel(text)) : undefined
				if (rule && ruleApplies(rule)) return null
			}
			return jsx(args[0], args[1], args[2])
		}),
	)
}

const MESSAGE_SHEET_KEY = /^MessageLongPress/

function labelledRows(env: Env) {
	env.cleanup(
		before(ActionSheetActionCreators, 'openLazy', args => {
			ui.messageSheetOpen = MESSAGE_SHEET_KEY.test(String(args[1]))
			return args
		}),
		before(ActionSheetActionCreators, 'hideActionSheet', args => {
			ui.messageSheetOpen = false
			return args
		}),
		before(ActionSheetActionCreators, 'hideAllActionSheets', () => {
			ui.messageSheetOpen = false
			return []
		}),
	)

	const ROW_PROPS = ['label', 'title', 'subLabel'] as const
	const GROUP_PROPS = ['title', 'label'] as const

	for (const row of [Design.ActionSheetRow, Design.TableRow])
		muteByLabel(env, row, ROW_LABELS, ROW_PROPS)
	muteByLabel(env, Design.TableRowGroup, GROUP_LABELS, GROUP_PROPS)

	// Screens that import the component directly may hold a different reference
	whenNamed(env, 'TableRow', ns =>
		muteByLabel(env, componentOf(ns), ROW_LABELS, ROW_PROPS),
	)
	whenNamed(env, 'ActionSheetRow', ns =>
		muteByLabel(env, componentOf(ns), ROW_LABELS, ROW_PROPS),
	)
	whenNamed(env, 'TableRowGroup', ns =>
		muteByLabel(env, componentOf(ns), GROUP_LABELS, GROUP_PROPS),
	)
}

// ---------------------------------------------------------------------------
// Voice call banner
// ---------------------------------------------------------------------------

const BANNER_TEXTS = new Set([
	'add people to voice chat',
	'let the group know you are here!',
])
const BANNER_PROPS = [
	'label',
	'title',
	'subLabel',
	'header',
	'text',
	'children',
]

/**
 * The call screen builds this banner from a component that is not one of the
 * design-system rows, so it is caught where its text is handed over in props.
 */
function voiceBanner(env: Env) {
	const isBanner = (props: unknown) => {
		if (!props || typeof props !== 'object') return false
		for (const name of BANNER_PROPS) {
			const text = textOfProp((props as Record<string, unknown>)[name])
			if (text && BANNER_TEXTS.has(normalizeLabel(text))) return true
		}
		return false
	}

	for (const factory of ['jsx', 'jsxs'] as const)
		env.cleanup(
			instead(ReactJSXRuntime as any, factory, (args: any[], original: any) =>
				isOn('voiceAddPeople') && !ui.settingsOpen && isBanner(args[1])
					? null
					: original(...args),
			),
		)
}

// ---------------------------------------------------------------------------
// Server header buttons (invite and events, next to the search pill)
// ---------------------------------------------------------------------------

interface HeaderButtonRule {
	option: OptionKey
	/** Icon asset names Discord may use for this button */
	icons: readonly string[]
	/** Accessibility label or text, when the icon alone is not enough */
	label: RegExp
}

const HEADER_BUTTONS: readonly HeaderButtonRule[] = [
	{
		option: 'guildInvite',
		icons: ['PersonPlusIcon', 'UserPlusIcon', 'UserAddIcon', 'InviteIcon'],
		label: /invite|add people/i,
	},
	{
		option: 'guildEvents',
		icons: [
			'CalendarIcon',
			'CalendarMonthIcon',
			'CalendarClockIcon',
			'EventIcon',
			'ScheduledEventIcon',
		],
		label: /events?\b/i,
	},
]

function serverHeader(env: Env) {
	let resolved: Array<[HeaderButtonRule, Set<number>]> | undefined

	// Asset ids are looked up on first use, once Discord's assets are registered
	const rules = () =>
		(resolved ??= HEADER_BUTTONS.map(rule => [
			rule,
			new Set(
				rule.icons
					.map(name => getAssetIdByName(name))
					.filter((id): id is number => typeof id === 'number'),
			),
		]))

	env.cleanup(
		insteadJSX(Design.IconButton, (args, jsx) => {
			if (!ui.settingsOpen) {
				const props = args[1] as {
					icon?: unknown
					label?: unknown
					accessibilityLabel?: unknown
				}
				const text =
					textOfProp(props?.accessibilityLabel) ?? textOfProp(props?.label)
				for (const [rule, ids] of rules())
					if (
						isOn(rule.option) &&
						((typeof props?.icon === 'number' && ids.has(props.icon)) ||
							(text !== undefined && rule.label.test(text)))
					)
						return null
			}
			return jsx(args[0], args[1], args[2])
		}),
	)
}

// ---------------------------------------------------------------------------

/** Each surface installs on its own, so one failing never blocks the rest */
export function installPatches(env: Env) {
	for (const install of [
		profileAndChat,
		questsAndShop,
		settingsPage,
		labelledRows,
		voiceBanner,
		serverHeader,
	])
		safely(env, () => install(env))
}
