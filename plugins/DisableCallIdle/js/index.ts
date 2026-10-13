import { Logger } from '@revenge-mod/discord/common/logger'
import { getModules } from '@revenge-mod/modules/finders'
import { withProps } from '@revenge-mod/modules/finders/filters'
import { instead } from '@revenge-mod/patcher'

const DEBUG: boolean = false

interface IdleTimer {
	start(...args: unknown[]): unknown
	stop(): unknown
}

interface CallIdleManager {
	idleTimeout: IdleTimer
	handleVoiceStateUpdates: unknown
	default?: { idleTimeout: IdleTimer }
}

export default plugin({
	start({ cleanup, plugin }) {
		const log = DEBUG ? new Logger('DisableCallIdle') : null
		let restore: (() => void) | undefined

		cleanup(
			getModules(
				withProps<CallIdleManager>('idleTimeout', 'handleVoiceStateUpdates'),
				(manager, id) => {
					try {
						const timer = manager.idleTimeout ?? manager.default?.idleTimeout

						timer.stop()
						restore = instead(timer, 'start', () => {})

						if (DEBUG) log?.log(`idle timer disabled in module ${id}`)
					} catch (e) {
						plugin.reportError(e)
					}
				},
				{ max: 1 },
			),
		)
		cleanup(() => restore?.())

		if (DEBUG) log?.log('started')
	},
})
