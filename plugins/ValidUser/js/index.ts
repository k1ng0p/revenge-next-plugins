const { lookupModule, waitForModules } = revenge.modules.finders;
const { filters } = revenge.modules.finders;
const { patcher } = revenge;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MENTION_REGEX = /<@!?(\d{17,19})>/g;
const COMPONENTS_V2_FLAG = 1 << 15;
const DEFAULT_EMBED_COLOR = 1974050;
const GATEWAY_OP_REQUEST_MEMBERS = 8;
const BULK_FETCH_THRESHOLD = 5;

const deletedUserPayload = (userId) => ({
	id: userId,
	username: "Deleted User",
	global_name: null,
	globalName: null,
	discriminator: "0000",
	avatar: null,
	avatarDecorationData: null,
	bot: false,
	system: false,
	flags: 0,
	publicFlags: 0,
	public_flags: 0,
	guildMemberAvatars: {},
});

const idsFromText = (text, isCached) =>
	!text ? [] : [...text.matchAll(MENTION_REGEX)].map((m) => m[1]).filter((id) => !isCached(id));

function idsFromComponents(components, isCached) {
	const ids = [];
	if (!Array.isArray(components)) return ids;
	for (const c of components) {
		if (!c) continue;
		if (c.type === 10 || typeof c.content === "string") ids.push(...idsFromText(c.content, isCached));
		if (Array.isArray(c.components)) ids.push(...idsFromComponents(c.components, isCached));
	}
	return ids;
}

function allMentionIds(message, isCached) {
	const ids = [];
	if (message.content) ids.push(...idsFromText(message.content, isCached));

	for (const embed of message.embeds ?? []) {
		if (embed.rawTitle) ids.push(...idsFromText(embed.rawTitle, isCached));
		if (embed.rawDescription) ids.push(...idsFromText(embed.rawDescription, isCached));
		for (const field of embed.fields ?? []) {
			if (field.rawName) ids.push(...idsFromText(field.rawName, isCached));
			if (field.rawValue) ids.push(...idsFromText(field.rawValue, isCached));
		}
	}

	ids.push(...idsFromComponents(message.components, isCached));

	for (const snapshot of message.messageSnapshots ?? []) {
		const snap = snapshot.message;
		if (!snap) continue;
		if (snap.content) ids.push(...idsFromText(snap.content, isCached));
		for (const embed of snap.embeds ?? []) {
			if (embed.rawTitle) ids.push(...idsFromText(embed.rawTitle, isCached));
			if (embed.rawDescription) ids.push(...idsFromText(embed.rawDescription, isCached));
		}
		ids.push(...idsFromComponents(snap.components, isCached));
	}

	return [...new Set(ids)];
}

function bustComponentsCache(components) {
	const clone = JSON.parse(JSON.stringify(components ?? []));
	function touch(nodes) {
		for (const node of nodes) {
			if (!node) continue;
			if (node.type === 10 || typeof node.content === "string") {
				node.content = `${node.content}\u200b`;
				return true;
			}
			if (Array.isArray(node.components) && touch(node.components)) return true;
		}
		return false;
	}
	touch(clone);
	return clone;
}

function hslaToInt(hsla) {
	const m = hsla.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*[\d.]+\s*)?\)$/i);
	if (!m) return DEFAULT_EMBED_COLOR;

	const h = Number.parseFloat(m[1]) / 360;
	const s = Number.parseFloat(m[2]) / 100;
	const l = Number.parseFloat(m[3]) / 100;

	if (s === 0) {
		const gray = Math.round(l * 255);
		return (gray << 16) | (gray << 8) | gray;
	}

	const hue = (p, q, t) => {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};

	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const r = Math.round(hue(p, q, h + 1 / 3) * 255);
	const g = Math.round(hue(p, q, h) * 255);
	const b = Math.round(hue(p, q, h - 1 / 3) * 255);
	return (r << 16) | (g << 8) | b;
}

const embedColor = (color) =>
	typeof color === "number" ? color : typeof color === "string" && color.startsWith("hsl") ? hslaToInt(color) : DEFAULT_EMBED_COLOR;

function toRawEmbed(embed) {
	if (!embed) return embed;
	const raw = {
		type: embed.type,
		url: embed.url,
		color: embedColor(embed.color),
		timestamp: embed.timestamp,
		title: embed.rawTitle ?? (typeof embed.title === "string" ? embed.title : undefined),
		description: embed.rawDescription ?? (typeof embed.description === "string" ? embed.description : undefined),
		author: embed.author && {
			name: embed.author.name,
			url: embed.author.url,
			icon_url: embed.author.iconURL ?? embed.author.icon_url,
			proxy_icon_url: embed.author.iconProxyURL ?? embed.author.proxy_icon_url,
		},
		image: embed.image && {
			url: embed.image.url,
			proxy_url: embed.image.proxyURL,
			width: embed.image.width,
			height: embed.image.height,
		},
		thumbnail: embed.thumbnail && {
			url: embed.thumbnail.url,
			proxy_url: embed.thumbnail.proxyURL,
			width: embed.thumbnail.width,
			height: embed.thumbnail.height,
		},
		video: embed.video,
		provider: embed.provider,
		footer: embed.footer && {
			icon_url: embed.footer.iconURL ?? embed.footer.icon_url,
			proxy_icon_url: embed.footer.iconProxyURL ?? embed.footer.proxy_icon_url,
			...embed.footer,
		},
	};
	if (Array.isArray(embed.fields)) {
		raw.fields = embed.fields.map((f) => ({
			name: f.rawName ?? (typeof f.name === "string" ? f.name : ""),
			value: f.rawValue ?? (typeof f.value === "string" ? f.value : ""),
			inline: f.inline,
		}));
	}
	return raw;
}

const isComponentsV2 = (flags) => typeof flags === "number" && (flags & COMPONENTS_V2_FLAG) === COMPONENTS_V2_FLAG;

let mods = {};

function resolve(cleanup, name, filter, onFound) {
	const [found] = lookupModule(filter);
	if (found) {
		mods[name] = found;
		onFound?.(found);
		return;
	}
	const stop = waitForModules(filter, (exports) => {
		stop();
		mods[name] = exports;
		onFound?.(exports);
	});
	cleanup(stop);
}

export default plugin({
	async start({ cleanup, plugin }) {
		const { Dispatcher } = revenge.discord.common.flux;
		mods = {};
		let ready = false;

		function setup() {
			if (ready) return true;

			const [UserStore] = lookupModule(filters.withProps("getUser", "getCurrentUser"));
			const [RestAPI] = lookupModule(filters.withProps("getAPIBaseURL", "get", "post"));
			if (!UserStore || !RestAPI) return false;
			ready = true;

			const isCached = (id) => !!UserStore.getUser?.(id);

			async function refreshMessageUI(channelId, msg) {
				const embeds = msg.embeds;
				const components = msg.components;

				Dispatcher.dispatch({
					type: "MESSAGE_UPDATE",
					message: { id: msg.id, channel_id: channelId, content: msg.content ? `${msg.content}\u200b ` : " ", embeds },
				});
				await sleep(110);

				if (isComponentsV2(msg.flags)) {
					Dispatcher.dispatch({
						type: "MESSAGE_UPDATE",
						message: {
							id: msg.id,
							channel_id: channelId,
							components: components?.length ? bustComponentsCache(components) : components,
							flags: msg.flags,
						},
					});
				} else {
					Dispatcher.dispatch({
						type: "MESSAGE_UPDATE",
						message: {
							id: msg.id,
							channel_id: channelId,
							content: msg.content,
							attachments: msg.attachments,
							embeds: embeds?.length ? embeds.map(toRawEmbed) : embeds,
							components,
						},
					});
				}
			}

			async function fetchViaGateway(userIds) {
				const guildId = mods.SelectedGuildStore?.getGuildId?.();
				const ws = mods.GatewayConnection?.getGateway?.();
				if (!guildId || !ws) return false;
				try {
					ws.send(GATEWAY_OP_REQUEST_MEMBERS, { guild_id: [guildId], limit: 100, user_ids: userIds, presences: true });
				} catch (err) {
					console.error("[ValidUser] gateway send failed", err);
					return false;
				}
				await sleep(400);
				return true;
			}

			async function fetchUser(userId) {
				if (isCached(userId)) return;

				if (typeof mods.UserUtils?.fetchUser === "function") {
					try {
						await mods.UserUtils.fetchUser(userId);
						return;
					} catch {}
				}

				try {
					const res = await RestAPI.get({ url: `/users/${userId}` });
					if (res.status === 200 && res.body) Dispatcher.dispatch({ type: "USER_UPDATE", user: res.body });
				} catch (err) {
					if (err?.status === 404 || err?.body?.code === 10013) {
						Dispatcher.dispatch({ type: "USER_UPDATE", user: deletedUserPayload(userId) });
					} else {
						console.error(`[ValidUser] fetch failed for ${userId}`, err);
					}
				}
			}

			async function fixMentions(message) {
				const ids = allMentionIds(message, isCached);
				if (ids.length === 0) return;

				const uncached = ids.filter((id) => !isCached(id));
				if (uncached.length > 0) {
					const viaGateway = uncached.length > BULK_FETCH_THRESHOLD && (await fetchViaGateway(uncached));
					if (!viaGateway) {
						const delay = uncached.length > 10 ? 800 : 200;
						for (let i = 0; i < uncached.length; i++) {
							await fetchUser(uncached[i]);
							if (i < uncached.length - 1) await sleep(delay);
						}
					}
				}

				await sleep(200);
				const channelId = message.channelId || message.channel_id;
				if (channelId && message.id) await refreshMessageUI(channelId, message);
			}

			const seen = new Set();

			function maybeFix(message) {
				if (!message?.id || seen.has(message.id)) return;
				if (allMentionIds(message, isCached).length === 0) return;
				seen.add(message.id);
				fixMentions(message).catch((err) => console.error(`[ValidUser] auto-fix failed for ${message.id}`, err));
			}

			function sweepChannel(channelId) {
				if (!channelId || !mods.MessageStore?.getMessages) return;
				try {
					const messages = mods.MessageStore.getMessages(channelId);
					const list = typeof messages?.toArray === "function" ? messages.toArray() : messages ?? [];
					for (const msg of list) maybeFix(msg);
				} catch (err) {
					console.error(`[ValidUser] channel sweep failed for ${channelId}`, err);
				}
			}

			const onMessageCreate = (payload) => payload?.message && maybeFix(payload.message);
			const onLoadMessages = (payload) => payload?.messages?.forEach(maybeFix);
			const onChannelSelect = (payload) => sweepChannel(payload?.channelId);

			Dispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
			Dispatcher.subscribe("LOAD_MESSAGES_SUCCESS", onLoadMessages);
			Dispatcher.subscribe("CHANNEL_SELECT", onChannelSelect);
			cleanup(
				() => Dispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate),
				() => Dispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS", onLoadMessages),
				() => Dispatcher.unsubscribe("CHANNEL_SELECT", onChannelSelect),
			);

			resolve(cleanup, "GatewayConnection", filters.withProps("getGateway", "send"));
			resolve(cleanup, "UserUtils", filters.withProps("fetchProfile", "getUser", "fetchUser"));
			resolve(cleanup, "MessageStore", filters.withProps("getMessages"), () => sweepChannel(mods.SelectedGuildStore?.getChannelId?.()));
			resolve(cleanup, "SelectedGuildStore", filters.withProps("getGuildId", "getChannelId"), (s) => sweepChannel(s?.getChannelId?.()));

			resolve(cleanup, "AvatarUtils", filters.withProps("getDefaultAvatarURL", "getUserAvatarURL"), (AvatarUtils) => {
				if (!AvatarUtils?.getDefaultAvatarURL) return;
				cleanup(
					patcher.instead(AvatarUtils, "getDefaultAvatarURL", (args, orig) => {
						try {
							const [id] = args;
							if (typeof id === "string" || typeof id === "number" || id == null) return orig(...args);
							return orig(String(id.id ?? "0"), typeof id.discriminator === "string" ? id.discriminator : "0000");
						} catch (err) {
							console.error("[ValidUser] getDefaultAvatarURL crash intercepted", err);
							return orig("0", "0000");
						}
					}),
				);
			});

			return true;
		}

		if (!setup()) {
			const stops = [];
			const retry = () => setup() && stops.forEach((stop) => stop());
			stops.push(waitForModules(filters.withProps("getUser", "getCurrentUser"), retry));
			stops.push(waitForModules(filters.withProps("getAPIBaseURL", "get", "post"), retry));
			cleanup(...stops);
		}

		if (plugin.startedLate) plugin.requireReload();
	},
});
