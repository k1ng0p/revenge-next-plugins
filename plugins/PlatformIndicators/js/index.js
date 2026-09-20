const { jsx, jsxs, Fragment } = revenge.react.ReactJSXRuntime;
const { React, ReactNative } = revenge.react;
const { getModules, filters } = revenge.modules.finders;
const { patcher, utils, jsonStorage } = revenge;

const getName = (m) => m?.name || m?.default?.name || m?.type?.name || m?.default?.type?.name || m?.render?.name || m?.default?.render?.name;
const withExactName = filters.createFilterGenerator(([n], _k, m) => getName(m) === n, ([n]) => `withExactName(${n})`, 1);
const withStatusAvatarBundle = filters.createFilterGenerator(
	(_, __, m) => !!m && typeof m.Status === "function" && typeof m.Avatar !== "undefined" && typeof m.BADGE_SIZE === "number",
	() => "withStatusAvatarBundle",
	filters.FilterScopes.Initialized | filters.FilterScopes.Uninitialized,
)([]);

function patchTarget(m) {
	if (typeof m?.default === "function") return { parent: m, key: "default" };
	if (typeof m?.default?.type === "function") return { parent: m.default, key: "type" };
	if (typeof m?.default?.render === "function") return { parent: m.default, key: "render" };
	if (typeof m?.type === "function") return { parent: m, key: "type" };
	if (typeof m?.render === "function") return { parent: m, key: "render" };
	return null;
}

const settings = jsonStorage.getJsonStorage(
	jsonStorage.pluginStoragePathFor("k1ngop.platform-indicators", "storage.json"),
	{ default: { dmTopBar: true, userList: true, profileUsername: true, fallbackColors: false, oldUserListIcons: false, experimentalStatusDot: false }, load: true },
);

let currentPlugin;

function SettingsPage() {
	const s = settings.use() ?? settings.cache;
	const set = (k, v) => settings.set({ [k]: v });
	const { Design } = revenge.discord.design;

	const rows = [
		["dmTopBar", "Show icons on the DM top bar"],
		["userList", "Show icons on the users and DMs list"],
		["profileUsername", "Show icons on user profiles"],
		["fallbackColors", "Theme compatibility mode"],
	];

	return jsx(revenge.components.Page, {
		children: jsxs(Design.TableRowGroup, {
			children: [
				...rows.map(([key, label]) =>
					jsx(Design.TableSwitchRow, { label, value: s?.[key] ?? key !== "fallbackColors", onValueChange: (v) => set(key, v) }, key),
				),
				jsx(Design.TableSwitchRow, {
					label: "Old user list icon style",
					subLabel: "Moves status indicators to the right",
					value: s?.oldUserListIcons ?? false,
					onValueChange: (v) => set("oldUserListIcons", v),
				}),
				jsx(Design.TableSwitchRow, {
					label: "Experimental: replace status dot with platform icon",
					subLabel: "Replaces the avatar status dot with the platform icon. Needs a reload.",
					value: s?.experimentalStatusDot ?? false,
					onValueChange: (v) => {
						set("experimentalStatusDot", v);
						currentPlugin?.requireReload();
					},
				}),
			],
		}),
	});
}

const FALLBACK_COLORS = { online: "#23a55a", dnd: "#f23f43", idle: "#f0b232", offline: "#80848e" };
const STATUS_TOKENS = { online: "STATUS_ONLINE", dnd: "STATUS_DANGER", idle: "STATUS_WARNING", offline: "STATUS_OFFLINE" };

function statusColor(status, useFallback) {
	if (useFallback) return FALLBACK_COLORS[status] ?? FALLBACK_COLORS.offline;
	try {
		const token = revenge.discord.common.Tokens?.colors?.[STATUS_TOKENS[status]];
		if (typeof token === "string") return token;
		if (typeof token?.resolve === "function") return token.resolve();
	} catch {}
	return FALLBACK_COLORS[status] ?? FALLBACK_COLORS.offline;
}

const ASSET_NAMES = {
	mobile: ["MobilePhoneIcon"],
	desktop: ["ic_monitor"],
	web: ["GlobeEarthIcon"],
	embedded: ["GameControllerIcon", "ic_playstation_device_ps5_32px"],
	vr: ["VrHeadsetIcon"],
};

const DOT_ASSET_NAMES = {
	mobile: ["StatusMobileOnline", ...ASSET_NAMES.mobile],
	vr: ["StatusVROnline", ...ASSET_NAMES.vr],
};

function normalizePlatform(p) {
	p = String(p || "").toLowerCase();
	if (p === "ios" || p === "android") return "mobile";
	if (p === "oculus" || p === "quest" || p === "samsung_gear_vr") return "vr";
	return p;
}

function findAsset(platform, forDot) {
	const key = normalizePlatform(platform);
	const names = (forDot && DOT_ASSET_NAMES[key]) || ASSET_NAMES[key] || [];
	for (const name of names) {
		const id = revenge.assets.getAssetIdByName(name, "png");
		if (id) return id;
	}
}

function PlatformIcon({ platform, color, iconSize = 16, width = iconSize, height = iconSize, forDot = false }) {
	const assetId = findAsset(platform, forDot);

	if (!assetId) return jsx(ReactNative.View, { children: jsx(ReactNative.View, { style: { width: iconSize, height: iconSize, borderRadius: 100, backgroundColor: color } }) });
	return jsx(ReactNative.View, { children: jsx(ReactNative.Image, { style: { width, height, tintColor: color, resizeMode: "contain" }, source: assetId }) });
}

let myId;

function getStatuses(userId) {
	myId ??= revenge.discord.flux.Stores.UserStore?.getCurrentUser?.()?.id;

	if (userId === myId) {
		const sessions = revenge.discord.flux.Stores.SessionsStore?.getSessions?.() ?? {};
		return Object.values(sessions).reduce((acc, s) => {
			const client = s?.clientInfo?.client;
			if (!client || client === "unknown") return acc;
			acc[normalizePlatform(client)] = s.status;
			return acc;
		}, {});
	}
	return revenge.discord.flux.Stores.PresenceStore?.getState?.()?.clientStatuses?.[userId];
}

const DOT_PRIORITY = ["desktop", "mobile", "web", "embedded", "vr"];
const FALLBACK_ASPECT = { mobile: 0.62, vr: 1.75, desktop: 1.15, web: 1, embedded: 1.3 };
const ART_FILL = { mobile: [0.92, 0.94], vr: [0.96, 0.92], desktop: [0.78, 0.66], web: [0.84, 0.84], embedded: [0.9, 0.72] };
const RING_RADIUS = { mobile: 0.2, desktop: 0.4, vr: 0.4, embedded: 0.4 };
const RING_THICKNESS = 3;

function pickDotPlatform(statuses) {
	return DOT_PRIORITY.find((p) => statuses[p]) ?? null;
}

function assetAspect(assetId, platform) {
	try {
		const { width, height } = ReactNative.Image.resolveAssetSource(assetId);
		if (width && height) return width / height;
	} catch {}
	return FALLBACK_ASPECT[platform] ?? 1;
}

function StatusIcons({ userId, size = 16 }) {
	const rerender = utils.react.useReRender();
	React.useEffect(() => revenge.discord.flux.onFluxEventDispatched("PRESENCE_UPDATES", (p) => { rerender(); return p; }), [rerender]);
	const statuses = getStatuses(userId) ?? {};
	const dotPlatform = settings.cache?.experimentalStatusDot ? pickDotPlatform(statuses) : null;
	return jsx(Fragment, {
		children: Object.keys(statuses).filter((p) => p !== dotPlatform).map((p) =>
			jsx(PlatformIcon, { platform: p, color: statusColor(statuses[p], settings.cache?.fallbackColors), iconSize: size }, p),
		),
	});
}

function StatusDot({ userId, original }) {
	const rerender = utils.react.useReRender();
	React.useEffect(() => {
		const { onFluxEventDispatched } = revenge.discord.flux;
		const offUpdates = onFluxEventDispatched("PRESENCE_UPDATES", (p) => {
			if (!Array.isArray(p?.updates) || p.updates.some((u) => u?.user?.id === userId)) rerender();
			return p;
		});
		const offReplace = onFluxEventDispatched("PRESENCES_REPLACE", (p) => { rerender(); return p; });
		return () => { offUpdates(); offReplace(); };
	}, [rerender, userId]);

	const statuses = getStatuses(userId) ?? {};
	const platform = pickDotPlatform(statuses);
	const assetId = platform && findAsset(platform, true);
	if (!assetId) return original;

	const kind = normalizePlatform(platform);
	const dotSize = typeof original.props.size === "number" ? original.props.size : 16;
	const box = dotSize + (dotSize <= 20 ? 4 : 3);
	const fit = kind === "vr" ? box * 1.1 : box;
	const aspect = assetAspect(assetId, kind);
	const width = aspect >= 1 ? fit : fit * aspect;
	const height = aspect >= 1 ? fit / aspect : fit;

	const [fillWidth, fillHeight] = ART_FILL[kind] ?? [1, 1];
	const ringWidth = width * fillWidth + RING_THICKNESS * 2;
	const ringHeight = height * fillHeight + RING_THICKNESS * 2;
	const shortSide = Math.min(ringWidth, ringHeight);
	const borderRadius = kind === "web" ? shortSide / 2 : Math.round(shortSide * (RING_RADIUS[kind] ?? 0.2));

	const style = ReactNative.StyleSheet.flatten(original.props.style) ?? {};
	const right = (typeof style.right === "number" ? style.right : -3) + box / 2 - ringWidth / 2;
	const bottom = (typeof style.bottom === "number" ? style.bottom : -3) + box / 2 - ringHeight / 2;

	return jsx(ReactNative.View, {
		style: {
			position: "absolute",
			right,
			bottom,
			width: ringWidth,
			height: ringHeight,
			borderRadius,
			alignItems: "center",
			justifyContent: "center",
			backgroundColor: style.backgroundColor ?? "#242429",
		},
		children: jsx(PlatformIcon, {
			platform,
			color: statusColor(statuses[platform], settings.cache?.fallbackColors),
			width,
			height,
			forDot: true,
		}),
	});
}

const WALK = { walkable: new Set(["props", "children"]) };
const hasUser = (n) => n?.props?.user?.id !== undefined;
const safely = (fn) => { try { fn(); } catch {} };

export default plugin({
	async start({ cleanup, plugin }) {
		currentPlugin = plugin;
		await settings.get();

		if (plugin.startedLate) plugin.requireReload();

		cleanup(getModules(withExactName("ChannelHeader"), (mod) => {
			const target = patchTarget(mod);
			if (!target) return;
			cleanup(patcher.after(target.parent, target.key, (result) => {
				safely(() => {
					if (!settings.cache?.dmTopBar || result?.type?.type?.name !== "PrivateChannelHeader") return;
					cleanup(patcher.after(result.type, "type", (header) => {
						safely(() => {
							const userId = utils.tree.findInTree(header, hasUser, WALK)?.props?.user?.id;
							if (!userId) return;

							const container = utils.tree.findInTree(header, (n) => n?.key === "DMTabsV2HeaderIcons", WALK);
							if (container) return void (container.props.children = jsx(StatusIcons, { userId }));

							const inner = header.props?.children?.props?.children?.props?.children?.[1];
							if (inner && typeof inner.type === "function") {
								const unpatch = patcher.after(inner, "type", (r) => {
									unpatch();
									safely(() => {
										if (!utils.tree.findInTree(r, (n) => n?.key === "DMTabsV2Header-v2", WALK)) {
											r.props.children[0]?.props?.children?.push(jsx(StatusIcons, { userId }, "DMTabsV2Header-v2"));
										}
									});
									return r;
								});
								cleanup(unpatch);
							}
						});
						return header;
					}));
				});
				return result;
			}));
		}));

		cleanup(getModules(withExactName("UserProfileContent"), (mod) => {
			const target = patchTarget(mod);
			if (!target) return;
			cleanup(patcher.after(target.parent, target.key, (result) => {
				safely(() => {
					const primary = utils.tree.findInTree(result, (n) => n?.type?.name === "PrimaryInfo", WALK);
					if (!primary) return;
					cleanup(patcher.after(primary, "type", (a) => {
						safely(() => {
							if (a?.type?.name !== "UserProfilePrimaryInfo") return;
							cleanup(patcher.after(a, "type", (b) => {
								safely(() => {
									const name = utils.tree.findInTree(b, (n) => n?.type?.name === "DisplayName", WALK);
									if (!name) return;
									cleanup(patcher.after(name, "type", (c) => {
										safely(() => {
											const userId = name.props?.user?.id;
											if (userId && settings.cache?.profileUsername) c?.props?.children?.push(jsx(StatusIcons, { userId }, "UserProfileIcons"));
										});
										return c;
									}));
								});
								return b;
							}));
						});
						return a;
					}));
				});
				return result;
			}));
		}));

		cleanup(getModules(filters.withProps("DisplayName"), (mod) => {
			cleanup(patcher.instead(mod, "DisplayName", (args, orig) => {
				const result = orig(...args);
				safely(() => {
					const user = args[0]?.user;
					const children = result.props?.children?.props?.children?.[0]?.props?.children;
					if (user?.id && Array.isArray(children) && settings.cache?.profileUsername) {
						if (children.some((c) => c?.key === "DisplayNameIcons")) return;
						children.push(jsx(StatusIcons, { userId: user.id }, "DisplayNameIcons"));
					}
				});
				return result;
			}));
		}));

		cleanup(getModules(withExactName("UserRow"), (mod) => {
			const target = patchTarget(mod);
			if (!target) return;
			cleanup(patcher.instead(target.parent, target.key, ([props], orig) => {
				const result = orig(props);
				safely(() => {
					const user = props?.user;
					if (!settings.cache?.userList || !user?.id) return;
					if (utils.tree.findInTree(result?.props?.label, (n) => n?.key === "TabsV2MemberListStatusIconsView", WALK)) return;

					result.props.label = jsxs(ReactNative.View, {
						style: { justifyContent: settings.cache?.oldUserListIcons ? "space-between" : "flex-start", flexDirection: "row", alignItems: "center" },
						children: [
							result.props.label,
							jsx(ReactNative.View, { style: { flexDirection: "row" }, children: jsx(StatusIcons, { userId: user.id }) }, "TabsV2MemberListStatusIconsView"),
						],
					}, "TabsV2MemberListStatusIconsView");
				});
				return result;
			}));
		}, { max: Infinity }));

		cleanup(getModules(withExactName("MessagesItemChannelContent"), (mod) => {
			const target = patchTarget(mod);
			if (!target) return;
			cleanup(patcher.instead(target.parent, target.key, ([props], orig) => {
				const result = orig(props);
				safely(() => {
					if (!settings.cache?.userList || props?.channel?.recipients?.length !== 1) return;
					const recipientId = props.channel.recipients[0];
					const titleNode = utils.tree.findInTree(result, (n) => n?.props?.children?.[0]?.props?.variant?.includes?.("channel-title"), WALK);
					if (titleNode && !utils.tree.findInTree(titleNode, (n) => n?.key === "TabsV2RedesignDMListIcons", WALK)) {
						titleNode.props?.children?.push(jsx(ReactNative.View, { style: { flexDirection: "row" }, children: jsx(StatusIcons, { userId: recipientId }) }, "TabsV2RedesignDMListIcons"));
					}
				});
				return result;
			}));
		}));

		cleanup(getModules(withStatusAvatarBundle, (mod) => {
			const target = typeof mod.Avatar?.type === "function" ? { parent: mod.Avatar, key: "type" }
				: typeof mod.Avatar === "function" ? { parent: mod, key: "Avatar" }
				: null;
			if (!target) return;

			cleanup(patcher.instead(target.parent, target.key, ([props], orig) => {
				const result = orig(props);
				if (!settings.cache?.experimentalStatusDot) return result;
				try {
					const kids = result?.props?.children;
					if (!Array.isArray(kids)) return result;

					const index = kids.findIndex((c) => (c?.type?.name ?? c?.type?.displayName) === "Status");
					if (index === -1) return result;
					const original = kids[index];

					const userId = props?.user?.id ?? kids.find((c) => c?.props?.user?.id)?.props?.user?.id;
					if (!userId) return result;

					const children = kids.slice();
					children[index] = jsx(StatusDot, { userId, original }, original.key ?? "StatusDot");
					return { ...result, props: { ...result.props, children } };
				} catch {
					return result;
				}
			}));
		}, { max: Infinity }));
	},
	stop() {
		this.requireReload();
	},
	SettingsComponent: SettingsPage,
});
		
