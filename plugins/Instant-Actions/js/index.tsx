const DEFAULTS = {
	autoConfirmMessage: true,
	autoConfirmEmbed: true,
	autoConfirmChannel: false,
	autoConfirmServer: false,
	autoConfirmGroup: false,
	autoConfirmRole: false,
	autoConfirmFriend: false,
	autoConfirmBlock: false,
	autoConfirmIgnore: false,
	autoConfirmCancelRequest: false,
	debug: false,
};

type Settings = typeof DEFAULTS;

// capture = confirm button isn't reachable via props, has to be rendered and pressed for real
const RULES: { on: keyof Settings; test: (key: string, title: string) => boolean; capture?: string }[] = [
	{ on: "autoConfirmMessage", test: (_, t) => t === "Delete Message" },
	{ on: "autoConfirmEmbed", test: (_, t) => t === "Delete Embed" },
	{ on: "autoConfirmChannel", test: (_, t) => t === "Delete Channel" },
	{ on: "autoConfirmServer", test: (k, t) => t === "Leave Server" || k === "guild-action-sheet-leave-server", capture: "Yes" },
	{ on: "autoConfirmGroup", test: (_, t) => t.startsWith("Leave '") },
	{ on: "autoConfirmRole", test: (_, t) => t.startsWith("Delete ") },
	{ on: "autoConfirmFriend", test: (k) => k === "remove-friend", capture: "Remove Friend" },
	{ on: "autoConfirmCancelRequest", test: (k) => k === "cancel-friend-request", capture: "Cancel Friend Request" },
];

// block/ignore skip openAlert entirely, matched by button shape instead
const BUTTON_RULES: { on: keyof Settings; text: string; variant?: string }[] = [
	{ on: "autoConfirmBlock", text: "Block", variant: "destructive" },
	{ on: "autoConfirmIgnore", text: "Ignore" }, // no variant - excludes the "secondary" ignore-friend-request button
];

const GROUPS: { title: string; rows: [key: keyof Settings, label: string, sub: string][] }[] = [
	{
		title: "Messages",
		rows: [
			["autoConfirmMessage", "Messages", "Deletes messages without confirmation"],
			["autoConfirmEmbed", "Embeds", "Deletes embeds without confirmation"],
		],
	},
	{
		title: "Servers & Groups",
		rows: [
			["autoConfirmChannel", "Channels", "Deletes channels without confirmation"],
			["autoConfirmServer", "Servers", "Leaves servers without confirmation"],
			["autoConfirmGroup", "Groups", "Leaves group DMs without confirmation"],
			["autoConfirmRole", "Roles", "Deletes roles without confirmation (also catches similar delete dialogs)"],
		],
	},
	{
		title: "Friends & DMs",
		rows: [
			["autoConfirmFriend", "Unfriend", "Removes friends without confirmation"],
			["autoConfirmBlock", "Block", "Blocks users without confirmation (this also unfriends them automatically)"],
			["autoConfirmIgnore", "Ignore", "Ignores users without confirmation"],
			["autoConfirmCancelRequest", "Cancel Friend Request", "Cancels outgoing friend requests without confirmation"],
		],
	},
	{
		title: "Debug",
		rows: [["debug", "Debug logging", "Logs alert data to Debug Logs, for troubleshooting"]],
	},
];

let logger: InstanceType<typeof revenge.discord.common.logger.Logger> | undefined;
let unpatch: (() => void) | undefined;
let unafterButton: (() => void) | undefined;

// capture window for dialogs whose confirm button only exists once rendered
let captureUntil = 0;
let captureText = "";
let fired = false;

const log = (...args: unknown[]) => {
	logger?.log(...args);
	console.log("[InstantActions]", ...args);
};

const flattenText = (node: any, depth = 0): string => {
	if (node == null || depth > 6) return "";
	if (typeof node === "string") return node;
	if (typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map((n) => flattenText(n, depth + 1)).join(" ");
	if (typeof node === "object" && "props" in node) return flattenText(node.props?.children, depth + 1);
	return "";
};

type Btn = { variant?: string; onPress: () => void };
const skipVariants = new Set(["secondary", "tertiary", "secondary-overlay"]);

const collectButtons = (node: any, out: Btn[], depth = 0) => {
	if (node == null || depth > 6) return;
	if (Array.isArray(node)) return node.forEach((n) => collectButtons(n, out, depth + 1));
	if (typeof node === "object" && "props" in node) {
		if (typeof node.props?.onPress === "function") out.push({ variant: node.props.variant, onPress: node.props.onPress });
		collectButtons(node.props?.children, out, depth + 1);
	}
};

const pickConfirm = (buttons: Btn[]) => {
	const destructive = buttons.find((b) => b.variant === "destructive");
	if (destructive) return destructive.onPress;
	if (buttons.length === 2) return buttons.find((b) => !skipVariants.has(b.variant ?? ""))?.onPress;
};

const Settings = ({ api }: { api: { jsonStorage: { use(): Settings; set(patch: Partial<Settings>): void } } }) => {
	const { Page } = revenge.components;
	const { Design } = revenge.discord.design;
	const settings = api.jsonStorage.use() ?? DEFAULTS;

	const { ScrollView } = revenge.react.ReactNative;

	return (
		<Page>
			<ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40, gap: 16 }}>
				{GROUPS.map((group) => (
					<Design.TableRowGroup title={group.title} key={group.title}>
						{group.rows.map(([key, label, sub]) => (
							<Design.TableSwitchRow
								key={key}
								label={label}
								subLabel={sub}
								value={settings[key]}
								onValueChange={(v: boolean) => api.jsonStorage.set({ [key]: v })}
							/>
						))}
					</Design.TableRowGroup>
				))}
			</ScrollView>
		</Page>
	);
};

export default plugin({
	jsonStorage: { default: DEFAULTS, load: true },
	start({ jsonStorage }) {
		logger = new revenge.discord.common.logger.Logger("InstantActions");

		unafterButton = revenge.react.jsxRuntime.afterJSX(revenge.discord.design.Design.Button, (element) => {
			const props = element?.props;
			if (typeof props?.onPress !== "function") return element;
			const text = flattenText(props.text ?? props.children);
			const settings = jsonStorage.cache ?? DEFAULTS;

			const btnRule = BUTTON_RULES.find((r) => settings[r.on] && text === r.text && props.variant === r.variant);
			if (btnRule) {
				if (settings.debug) log("button", btnRule.on, text);
				queueMicrotask(props.onPress);
				return element;
			}

			// microtask instead of setTimeout(0) - runs before the frame paints,
			// so the dialog ideally never becomes visible
			if (Date.now() < captureUntil && !fired && props.variant === "destructive" && text === captureText) {
				fired = true;
				queueMicrotask(props.onPress);
			}
			return element;
		});

		unpatch = revenge.patcher.instead(revenge.discord.actions.AlertActionCreators, "openAlert", (args, original) => {
			const [key, alert] = args;
			const settings = jsonStorage.cache ?? DEFAULTS;
			const props = alert?.props;
			const title = flattenText(props?.title);
			const rule = RULES.find((r) => settings[r.on] && r.test(key, title));

			if (!rule) {
				if (settings.debug) log("no match", { key, title });
				return original(...args);
			}

			const buttons: Btn[] = [];
			collectButtons(props?.actions, buttons);
			const confirm = pickConfirm(buttons);

			if (settings.debug) log("matched", { key, title, on: rule.on, pickedConfirm: !!confirm });

			if (confirm) return confirm();

			if (!rule.capture) return original(...args);

			// no button reachable via props - render it for real and catch the
			// confirm button once React actually creates it (brief flash)
			fired = false;
			captureText = rule.capture;
			captureUntil = Date.now() + 3000;
			return original(...args);
		});
	},
	stop() {
		unpatch?.();
		unpatch = undefined;
		unafterButton?.();
		unafterButton = undefined;
	},
	SettingsComponent: Settings,
});
    
