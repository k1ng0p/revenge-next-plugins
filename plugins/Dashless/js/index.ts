const fix = (n: any): any => {
	if (typeof n === 'string') return n.replace(/-/g, ' ')
	if (Array.isArray(n)) return n.map(fix)
	if (n?.props?.children) return { ...n, props: { ...n.props, children: fix(n.props.children) } }
	return n
}

export default plugin({
	start({ cleanup, plugin }) {
		if (plugin.startedLate) {
			plugin.requireReload()
			return
		}

		const { View } = revenge.react.ReactNative
		const off = revenge.patcher.after(View, 'render', (...a: any[]) => {
			const res = a.find(x => x?.$$typeof)
			if (!res) return
			try {
				return fix(res)
			} catch {}
		})

		cleanup(off, () => plugin.requireReload())
	},
})
