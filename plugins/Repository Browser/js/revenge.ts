import { RootNavigationRef } from '@revenge-mod/discord/modules/main_tabs_v2'
import { formatVersion } from '@revenge-mod/plugins/utils'
import { askReload, asObject, confirm, errorMessage, fail, native, reportError, showError, slash, usesEnvelope } from './shared'
import type { AvailableUpdate, ListedPlugin, Repo, RevengeRepo } from './shared'
export type PendingUpdate = { id: string; name: string; installed: string; available: string; channel: string }
export type RevengeState = Awaited<ReturnType<typeof readState>>

export const available = new Map<string, AvailableUpdate>()
export const pendingReload = new Set<string>()

let repoWrites: Promise<unknown> = Promise.resolve()

const repoList = (): Promise<RevengeRepo[]> => native('revenge.plugins.repos.list')

const warningMessages = (plan: any): string[] =>
	(plan?.warnings ?? [])
		.filter((warning: any) => warning?.type !== 'upToDate')
		.map((warning: any) => (typeof warning === 'string' ? warning : warning?.message))
		.filter(Boolean)

export async function readState() {
	const envelope = await usesEnvelope()
	const [repos, plugins, saved, slots] = await Promise.all([
		repoList(),
		native('revenge.plugins.list'),
		native('revenge.plugins.states.read'),
		envelope ? native('revenge.plugins.states.getSlots').catch(() => null) : null,
	])

	const installed = new Map<string, { version: string; settings: boolean }>()
	for (const plugin of plugins ?? []) {
		if (plugin.internal) continue
		installed.set(plugin.manifest.id, {
			version: formatVersion(plugin.manifest.version),
			settings: !!plugin.script?.includes('SettingsComponent'),
		})
	}

	const enabled: Record<string, { enabled?: boolean; pendingReload?: boolean }> = envelope ? (asObject(saved)[slots?.active] ?? {}) : (saved?.states ?? {})
	return { repos: repos ?? [], installed, enabled }
}

export async function refreshAvailable(catalog: Repo[]) {
	const added = await repoList().catch(error => {
		reportError(error)
		return []
	})
	const envelope = await usesEnvelope()
	const found: AvailableUpdate[] = []
	const checked = new Set<string>()

	const active = catalog.filter(repo => added.some(item => !item.internal && item.enabled && slash(item.url) === slash(repo.url)))
	// revenge plans updates from its own cached index, so refresh that first
	await Promise.all(active.map(repo => native('revenge.plugins.repos.refresh', [repo.url]).catch(() => {})))

	if (envelope) {
		try {
			const updates: any[] = (await native('revenge.plugins.listUpdates')) ?? []
			for (const repo of active) {
				checked.add(repo.url)
				for (const update of updates) if (!update.blocker && slash(update.repo ?? '') === slash(repo.url)) found.push({ ...update, repo: repo.url })
			}
		} catch {
			// not indexed yet
		}
	} else {
		await Promise.all(
			active.map(async repo => {
				try {
					for (const update of (await native('revenge.plugins.repos.listUpdates', [repo.url])) ?? []) found.push({ ...update, repo: repo.url })
					checked.add(repo.url)
				} catch {
					// not indexed yet
				}
			}),
		)
	}

	for (const [id, info] of available) if (checked.has(info.repo) || !catalog.some(repo => repo.url === info.repo)) available.delete(id)
	for (const info of found) available.set(info.id, info)

	return checked
}

async function writeRepos(url: string, enabled: boolean) {
	const list = (await repoList()).filter(repo => !repo.internal).map(repo => ({ url: repo.url, enabled: slash(repo.url) === slash(url) ? enabled : repo.enabled }))
	if (!list.some(repo => slash(repo.url) === slash(url))) list.push({ url, enabled })
	await native('revenge.plugins.repos.set', [list])
	await native('revenge.plugins.repos.refresh', [url]).catch(() => {})
}

export function putRepos(url: string, enabled: boolean) {
	const job = repoWrites.then(() => writeRepos(url, enabled))
	repoWrites = job.catch(() => {})
	return job
}

export function openPluginSettings(id: string) {
	const nav = RootNavigationRef.getRootNavigationRef()
	if (nav.isReady()) (nav as any).navigate(id)
}

export async function uninstall(plugin: ListedPlugin, dependents: string[] = []) {
	const warning = dependents.length ? `\n\nRequired by: ${dependents.join(', ')}. Removing it may break them.` : ''
	if (!(await confirm('Uninstall plugin?', `${plugin.name} and all of its data will be removed. This cannot be undone.${warning}`, 'Uninstall', 'destructive'))) return false
	try {
		await native('revenge.plugins.setEnabled', [plugin.id, false, false]).catch(() => {})
		await native('revenge.plugins.uninstall', [plugin.id])
		askReload('Uninstalled. Reload to apply it.')
		return true
	} catch (e) {
		fail(e)
		return false
	}
}

export async function install(repoUrl: string, plugin: ListedPlugin) {
	try {
		const known = (await repoList()).find(repo => slash(repo.url) === slash(repoUrl))
		if (!known?.enabled) {
			showError(new Error('Add this repository to Revenge first'))
			return false
		}

		const envelope = await usesEnvelope()
		const plan = await native('revenge.plugins.planInstall', envelope ? [plugin.id, { repos: [known.url] }] : [plugin.id, null, null, [known.url]])
		const others = plan.actions.filter((action: any) => action.id !== plugin.id).map((action: any) => `${action.id} ${action.version}`)
		const warnings = warningMessages(plan)

		const lines = [`${plugin.name} ${plan.actions.find((action: any) => action.id === plugin.id)?.version ?? ''}`]
		if (others.length) lines.push(`Also installs: ${others.join(', ')}`)
		if (warnings.length) lines.push(warnings.join('\n'))
		if (!(await confirm('Install plugin?', lines.join('\n\n')))) return false

		const result = await native('revenge.plugins.install', [plan])
		if (result?.pending?.length) askReload('Installed. Reload to apply it.')
		return true
	} catch (e) {
		fail(e)
		return false
	}
}

export async function updatePlugins(updates: PendingUpdate[]) {
	const done: PendingUpdate[] = []
	try {
		const envelope = await usesEnvelope()
		const plans: any[] = []
		for (const item of updates) {
			plans.push(await native('revenge.plugins.planInstall', envelope ? [item.id, { skipMissingOptionals: true }] : [item.id, null, item.channel, null]))
		}

		const lines = updates.map(item => `${item.name} ${item.installed} to ${item.available}`)
		const warnings = plans.flatMap(warningMessages)
		if (warnings.length) lines.push(warnings.join('\n'))
		const title = updates.length === 1 ? 'Update plugin?' : `Update ${updates.length} plugins?`
		if (!(await confirm(title, lines.join('\n'), 'Update'))) return false

		for (const [index, plan] of plans.entries()) {
			await native('revenge.plugins.install', [plan])
			pendingReload.add(updates[index].id)
			done.push(updates[index])
		}
		askReload('Updated. Reload to apply it.')
		return true
	} catch (e) {
		reportError(e)
		if (done.length) askReload(`Updated ${done.length} of ${updates.length}. ${errorMessage(e)}\nReload to apply the ones that worked.`)
		else showError(e)
		return false
	}
}

async function writeEnabled(id: string, on: boolean) {
	const res = await native('revenge.plugins.setEnabled', [id, on, on])
	if (res?.code) {
		const message = res.problems?.map((problem: any) => `${problem.id} (${problem.required})`).join(', ') ?? res.code
		throw Object.assign(new Error(message), { code: res.code, details: { problems: res.problems } })
	}
}

async function setEnabled(id: string, on: boolean) {
	try {
		await writeEnabled(id, on)
	} catch (e: any) {
		const disabled = on ? (e?.details?.problems ?? []).filter((problem: any) => problem.installed && !problem.enabled) : []
		if (!disabled.length) throw e
		for (const dependency of disabled) await native('revenge.plugins.setEnabled', [dependency.id, true, false])
		await writeEnabled(id, on)
	}
}

export async function toggle(id: string, on: boolean) {
	try {
		await setEnabled(id, on)
		askReload(`${on ? 'Enabled' : 'Disabled'}. Reload to apply it.`)
		return true
	} catch (e) {
		fail(e)
		return false
	}
}
