const { jsx, jsxs, Fragment } = revenge.react.ReactJSXRuntime;
const { React, ReactNative } = revenge.react;
const { getModules, filters } = revenge.modules.finders;
const { patcher, utils, jsonStorage } = revenge;

const getName = (m) => m?.name || m?.default?.name || m?.type?.name || m?.default?.type?.name || m?.render?.name || m?.default?.render?.name;
const withExactName = filters.createFilterGenerator(([n], _k, m) => getName(m) === n, ([n]) => `withExactName(${n})`, 1);

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
	{ default: { dmTopBar: true, userList: true, profileUsername: true, fallbackColors: false, oldUserListIcons: false }, load: true },
);

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
			],
		}),
	});
}

const FALLBACK_COLORS = { online: "#23a55a", dnd: "#f23f43", idle: "#f0b232", offline: "#80848e" };
const STATUS_TOKENS = { online: "STATUS_ONLINE", dnd: "STATUS_DANGER", idle: "STATUS_WARNING", offline: "STATUS_OFFLINE" };

function statusColor(status, useFallback) {
	if (useFallback) return FALLBACK_COLORS[status] ?? FALLBACK_COLORS.offline;
	try {
		const token = revenge.discord.common.tokens.Tokens?.colors?.[STATUS_TOKENS[status]];
		if (typeof token === "string") return token;
		if (typeof token?.resolve === "function") return token.resolve();
	} catch {}
	return FALLBACK_COLORS[status] ?? FALLBACK_COLORS.offline;
}

const PNG_ICONS = {
	mobile: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAACXBIWXMAAC4jAAAuIwF4pT92AAABkElEQVR4nO3cS0rDYBSG4YDuQEWd6HZK6wq0Ay+b6LAL0LoBEcRleBm2VrwsQMG5CLoA5ZUfOtR+haRJTvO900LPyTNIZifLcgYsA0fALfBB9aUdboDDtFve58uLsw08U9+e0o5V4awAr9S/N2CtCqBL4nReNs4m8EOcvoH1MoG6xGuvTKAe8eqVCdQnXn0D1Rkoq1kGEhlIZCCRgUQGEhlIZCCRgUQGEhlIZCCRgUQGEhlIZCCRgUQGEhlIZCCRgUQGEhlIZCCRgUQGEhlIZCCRgUQGEhlIZCCRgUQGEhlIZCCRgUQGEhlIZCCRgUQGEhlIZCCRgaIBBchAIgOJDLToQEPgBBgAozn8f1igT6D1x4z25DeaDtSaMqfTdKDhDLPumgx0PMOs9F4qooUFGjQZaDTDrHFEoB7F1Z4yZyfqaYpugYunT3nnH5yvAufslgm0MYfzOOPJ++YUuA99HicFXBCns6yiE10vxDjRtVo6UArYAh6pbw9px6zKgCXgALgG3qsWmexwBeyn3fI+4C80c7l39QpzbQAAAABJRU5ErkJggg==", path: "PlatformIndicators/Mobile.png" },
	desktop: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAMAAABiM0N1AAAAVFBMVEUAAACvv7+3u7+5u7+2ub+4u726vL65u765vL65vMG5u723ub23v7+3t7+6vL+4ur+6u765u764vL+4ur23t7+7vb+3ur25ur64ur+7u766ur6vr7/+1nXbAAAAHHRSTlMAEEB/UHDv/99fgIAgQJ+f7++fnyB/YN9vTz8QSaZf3QAAAI1JREFUeAHt1tUBwkAURNEXHZzg1n+d2Fc8u4OTOQXcyKqJ3ARh5C22qiQFYTC0khFIYyuYgDYthGagzQuhDLRFIYS7yBPuakLmSaF2CimkkEIKKfT8I5un0MdCT7v6LUFbFUIhaGsr2IAUWcl2B0K2t6pDVKttGR5P3BJvpxCnfdTMHVo9NaRQ1MpKRC5jHSw3VFQzIwAAAABJRU5ErkJggg==", path: "PlatformIndicators/Desktop.png" },
	web: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAQAAAD/5HvMAAADgklEQVR42u3a32vVdRzH8VdOv2NzGzM7bkp0E9F9RQSbOmK6groQpeugOzXJfnCW3YwgC4IyHCldrBmFELtQRxfK2MHp1sjVZRfBMSJFYu6cMUnOOZPz9Gb45uyc79fv5/tDvDiPv+DJh/fn8+HL56umpqbHFZsZ4hjjzJOnQJkyBfLMM87H7GWzHh16OcoVKgQpM8N79Cht7GaSVcJa5QK7lBZe5SpRzDCgpLGdH6gS3SRPKzm8xTJxFTmgJNDKtyRllFbFQxfTRLVCvSk6FR3b+J3onuRTlllvgUzk1YmVsyJJdPMN1bqkzmizM00cc1rDIP9SawpPrjhFPAf1AN1cotZJ940ezwKb1q33BLX2Kzx2sBwzZ7vWoYXvAVOkV2FxlqjuMMtBNqkBNpIDzI/h7ywnTsfIP5gquxUGV3EiB7zMPcxlPRwDOJITTgNmpx6GyZSDnqKAOa9g9LKKIzniA0yFbQrC+5B6UDf/Y44oCFdwdUPOGMfkgr8kyrg6Lmf0YUq0yw9DuLnBcTw5YwNFzB754RhmkYaUCH7BDMsPZzDDZFMM+gQzJj/8inlTYiS1oNcws/LD35jnJUtKPOgFzHX5YQmzdmCRTSXoGcyi/FDGtEqWlHhQG6YULsjTA4zg5iZf4CkAXrig25gtUowk+FwB2IpZDDfUz8pEWiUF4DnM9XDbfkiKl6QAvB5u248H38KMJBZ0FDMW7uo4qwbIJhQ0gcnKD3sxN3lCirNKgZfrf5hB+aGdEuYVNUQ2dtAuTIk2+WMG87V8MBIzaBQzrdDDVqBDPuIE0cUy5rCC0MMq5lAqQR9hKmRcPoNu0ZF0EN0sYs7JBAyc+UwNsUJYd7nGO2zUGr4CTL9MqMGu8KIaYB43C2yVJPq4h8kpDAaoYv6kS3U4jKvfaGELeUyVfoXDT4C5wAatg8cfuHqbS4A54/K8UgTMd/WnNjuckyqAKdCj8DhArdO0NFilQ8xxhyiq7JMbRqk1GXAEuDshV3hMUesvXkoo6CKe3NHJArUqfEln7KBrdCgaMnVJcIsPa6OcczKKjk6mqFfkFH20RAi6SIfiweMkjS0xwTBvEFaVE3hKAvspEleBfUoOvTGfOH+mJ40X6ctEkaNfaWEn56kQVoVz9CltZDhCjhJBSuR4l4weHdrZwzBjzJFniTJlbpNnljGyDNLW/BmlqelxdR++AoGbDB4jjAAAAABJRU5ErkJggg==", path: "PlatformIndicators/Web.png" },
	embedded: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAMAAABiM0N1AAAAk1BMVEUAAAC3u7+4ur+5vL+5u765u7+6vL+2ub+3v7+6u7+5vL66v7+6vL65u761ur+4u765vL+3t7+6u765u7+9vb23t7+7vb+6u766ur+5ur6/v7+vv7+9vcW1tb+5u727u763ur25vL+6vL+3ub24ur+5u7+4vL+5ur66ur64ur25vL+6u764ur24u722uby5u76vr7/eehxsAAAAMXRSTlMAQJ/f/8+fUCC/3zDv7zC/UEDvfx8gf88w3xAQHzCAT2Bfb4Bvj5/PP6+vv59wUM8QEONx+AAAAWZJREFUeAHt1dWa6zAMBOA5PSqzs2Vmhvd/uWWcVFHqr5f+r+3JRqtJ8UhBEAT/Mv8lpWwuD02hKHcpFXBTuSJ3qtZwQ0HPUVULiCuJhzpiGuKlCZaTL3gnxEVPaLWdkAxYJznIdfGmy0k9MEkOivChLQSkbwS18KElZEBBLSMIX4QMuRxaEJ0vCBndCkJMbEZjIRO6MTWCqjWlRjO6MTeCpLoooDWuCFvSjcgK0pYzohsrM0hZzhXdWJtBynJyR4rGv19dzrp3EC3nhoJKZpCynNxalzqIlrPKU7WDlOXUym8H0XIOufy+htxZX9tHBU24/L5mXH5fSy6/r4jL/8sOidYJv2x7fu0k84SgIn/Qmb50dT2oB6YXk+tf4hElWuuPdeaIlCFx/fkLeM+Q1Ferw3RQZ9SmP8jQlR9H/NZ3tKmG08+sW/SMnrxzZ6Qy/TrfBWkdL+Lq0RUptaYHJyU+HwRB4O0FjTMnvIkvoBQAAAAASUVORK5CYII=", path: "PlatformIndicators/Console.png" },
	vr: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAACXBIWXMAAD2EAAA9hAHVrK90AAADg0lEQVR4nO2aXWiOYRjH77WYrzVyoJYjWZSPONqiUKTIslE+okkpB5tpUgw5pRw4RIp8HCg7lAPKtw1ppki+JsZ8bL6GfO310829Wuy9n/t+n+d597xcv9rJu/e9rv91PddzP9dz35dSgiAIgiAIgiAIgiAIQjqAPKAMqAdOAneATuKj0/jQvjYb33kqaQBDgFojtr/RGtZpTSoJAOXAI5LHU6CqPxNTABwk+RwABmY7OSOAS+QOF4Hh2UrOIOC8p8CPwJuI/957ajirqz4bCTrqIKYJ2AhMBUbFqGUwMB6oAc456DoUl5ZfAIsCBNwC5qp+ApgF3AjQuDAu54VAu8VxAzA0Fuf+S8CRgKfbsDgc11mcngDyVbIaVluSaqN2mA88TOPsdmKasr8rKd3t9iDUBdV9g1n4GoF32Om3NScIYEaAdh3bZaDauVcCRgMtuNGoEg5wxjGWZqDYpSxv4k6NSjjAWo94mq2VBKzHj3Eq4QBjPWOqthm75mGoO+vvOBkADDBaXWmyGfvgYei5yhGAlx5xddkM+dCqcgR9MX0Csxny4a7KEYBnkiALkqAAgDapIAvAE0mQBeCxJMiC76HC//gUa5UEWbBs1XhXUPc/WkH3PeLqjqqhuqdyBK3VI642myHbNuWfvFI5AtCBO+lPPoApQMrRUAooimDveDqwD7hiDgXazbHRHmBaGPvGR5FHTHqJmRxkcINHtitDCJ/kuL1yFZgY41FVb+pcja4AXjgYPJWh6Crgq4dw/d2VGfo67WBfv+0vz+TUshzYBByzGJ/nabcC+I4/+jcVnr7mW+wdN7Et0LF6JSfN/M/bNI50pZU42pkDfCFz9G9nO/oqsdwF+ly/MFRS+nC4yyJcL6wzA36/ygwxhKUr6HbTWgJOgXdHmpxeTwPb1uUPc/ysb8tiMyKjr+Ia4IJD0LrcJ+gF2YzT6c+CpjVWA2OMr2Lju8FoSYeOYYSKA36vHzbnmfAJKO3DV6n5X5Ro7YtjSU4PwPYIBadsgoElHj2MC9tUNgC2RCD2m8uj1bQc+rthK6c+K8npQc/ZOPZKfaHfrsuUI2a812vLohftYRraUAAjgR0OC2oPHab6vKdBTF+21eOMS4/p7czabKLDcNVS4LAZOflsRL425917TctfENF0bSWwH7hufKRMNbeYz5clYZhLEARBEARBEARBEARBJY+fZ9NKSgsY9YQAAAAASUVORK5CYII=", path: "PlatformIndicators/VR.png" },
};

function normalizePlatform(p) {
	p = String(p || "").toLowerCase();
	if (p === "ios" || p === "android") return "mobile";
	if (p === "oculus" || p === "quest" || p === "samsung_gear_vr") return "vr";
	return p;
}

function PlatformIcon({ platform, color, iconSize = 16 }) {
	const icon = PNG_ICONS[normalizePlatform(platform)];
	if (!icon) return jsx(ReactNative.View, { children: jsx(ReactNative.View, { style: { width: iconSize, height: iconSize, borderRadius: 100, backgroundColor: color } }) });
	return jsx(ReactNative.View, { children: jsx(ReactNative.Image, { style: { height: iconSize, width: iconSize, tintColor: color }, source: { uri: icon.url, width: iconSize, height: iconSize, path: icon.path, allowIconTheming: true } }) });
}

let presence, presenceTicks = 0, presenceResetAt, myId;

function getPresence() {
	if (!presenceResetAt) presenceResetAt = setTimeout(() => { presenceTicks = 0; presenceResetAt = null; }, 5000);
	if (!presence || presenceTicks === 0) presence = revenge.discord.flux.Stores.PresenceStore?.getState?.();
	presenceTicks = (presenceTicks + 1) % 20;
	return presence;
}

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
	return getPresence()?.clientStatuses?.[userId];
}

function StatusIcons({ userId, size = 16 }) {
	const rerender = utils.react.useReRender();
	React.useEffect(() => revenge.discord.flux.onFluxEventDispatched("PRESENCE_UPDATES", (p) => { rerender(); return p; }), [rerender]);
	const statuses = getStatuses(userId) ?? {};
	return jsx(Fragment, {
		children: Object.keys(statuses).map((p) =>
			jsx(PlatformIcon, { platform: p, color: statusColor(statuses[p], settings.cache?.fallbackColors), iconSize: size }, p),
		),
	});
}

const WALK = { walkable: new Set(["props", "children"]) };
const hasUser = (n) => n?.props?.user?.id !== undefined;
const safely = (fn) => { try { fn(); } catch {} };

export default plugin({
	async start({ cleanup }) {
		await settings.get();

		cleanup(revenge.discord.flux.onFluxEventDispatched("PRESENCE_UPDATES", (p) => { presence = null; return p; }));

		// DM top bar
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

		// Profile display name
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

		// Message headers
		cleanup(getModules(filters.withProps("DisplayName"), (mod) => {
			cleanup(patcher.instead(mod, "DisplayName", (args, orig) => {
				const result = orig(...args);
				safely(() => {
					const user = args[0]?.user;
					if (user?.id && result && settings.cache?.profileUsername) {
						result.props?.children?.props?.children?.[0]?.props?.children?.push(jsx(StatusIcons, { userId: user.id }, "DisplayNameIcons"));
					}
				});
				return result;
			}));
		}));

		// Member list
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

		// DM list previews
		cleanup(getModules(withExactName("MessagesItemChannelContent"), (mod) => {
			const target = patchTarget(mod);
			if (!target) return;
			cleanup(patcher.instead(target.parent, target.key, ([props], orig) => {
				const result = orig(props);
				safely(() => {
					if (!settings.cache?.userList || props?.channel?.recipients?.length !== 1) return;
					const recipientId = props.channel.recipients[0];
					utils.tree.findInTree(result, (n) => n?.props?.children?.[0]?.props?.variant?.includes?.("channel-title"), WALK)
						?.props?.children?.push(jsx(ReactNative.View, { style: { flexDirection: "row" }, children: jsx(StatusIcons, { userId: recipientId }) }, "TabsV2RedesignDMListIcons"));
				});
				return result;
			}));
		}));
	},
	SettingsComponent: SettingsPage,
});