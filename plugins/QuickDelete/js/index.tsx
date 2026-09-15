const DEFAULTS = { autoConfirmMessage: true, autoConfirmEmbed: true, debug: false };
const TITLE = { message: "Delete Message", embed: "Delete Embed" };
const NonConfirmVariants = new Set(["secondary", "tertiary", "secondary-overlay"]);

let logger: InstanceType<typeof revenge.discord.common.logger.Logger> | undefined;
let unpatch: (() => void) | undefined;

const log = (...args: unknown[]) => {
	logger?.log(...args);
	console.log("[QuickDelete]", ...args);
};

const flattenText = (node: any, depth = 0): string => {
	if (node == null || depth > 6) return "";
	if (typeof node === "string") return node;
	if (typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map((n) => flattenText(n, depth + 1)).join(" ");
	if (typeof node === "object" && "props" in node) return flattenText(node.props?.children, depth + 1);
	return "";
};

type Button = { variant?: string; onPress: () => void };

const collectButtons = (node: any, out: Button[], depth = 0) => {
	if (node == null || depth > 6) return;
	if (Array.isArray(node)) {
		for (const child of node) collectButtons(child, out, depth + 1);
		return;
	}
	if (typeof node === "object" && "props" in node) {
		const props = node.props;
		if (typeof props?.onPress === "function") out.push({ variant: props.variant, onPress: props.onPress });
		collectButtons(props?.children, out, depth + 1);
	}
};

const pickConfirmButton = (buttons: Button[]) => {
	const destructive = buttons.find((b) => b.variant === "destructive");
	if (destructive) return destructive.onPress;
	if (buttons.length === 2) return buttons.find((b) => !NonConfirmVariants.has(b.variant ?? ""))?.onPress;
};

const Settings = ({ api }: { api: { jsonStorage: { use(): typeof DEFAULTS; set(patch: Partial<typeof DEFAULTS>): void } } }) => {
	const { Page } = revenge.components;
	const { Design } = revenge.discord.design;
	const settings = api.jsonStorage.use() ?? DEFAULTS;

	return (
		<Page>
			<Design.TableRowGroup title="Settings">
				<Design.TableSwitchRow
					label="Messages"
					subLabel="Deletes messages without confirmation"
					value={settings.autoConfirmMessage}
					onValueChange={(v) => api.jsonStorage.set({ autoConfirmMessage: v })}
				/>
				<Design.TableSwitchRow
					label="Embeds"
					subLabel="Deletes embeds without confirmation"
					value={settings.autoConfirmEmbed}
					onValueChange={(v) => api.jsonStorage.set({ autoConfirmEmbed: v })}
				/>
				<Design.TableSwitchRow
					label="Debug logging"
					subLabel="Logs alert data to logcat, for troubleshooting"
					value={settings.debug}
					onValueChange={(v) => api.jsonStorage.set({ debug: v })}
				/>
			</Design.TableRowGroup>
		</Page>
	);
};

export default plugin({
	jsonStorage: { default: DEFAULTS, load: true },
	start({ jsonStorage }) {
		logger = new revenge.discord.common.logger.Logger("QuickDelete");

		unpatch = revenge.patcher.instead(revenge.discord.actions.AlertActionCreators, "openAlert", (args, original) => {
			const [key, alert] = args;
			const settings = jsonStorage.cache ?? DEFAULTS;
			if (!settings.autoConfirmMessage && !settings.autoConfirmEmbed) return original(...args);

			const props = alert?.props;
			const title = flattenText(props?.title);
			const content = flattenText(props?.content);
			const isMessage = settings.autoConfirmMessage && title === TITLE.message;
			const isEmbed = settings.autoConfirmEmbed && title === TITLE.embed;

			if (!isMessage && !isEmbed) {
				if (settings.debug) log("openAlert (no match)", { key, title, content });
				return original(...args);
			}

			const buttons: Button[] = [];
			collectButtons(props?.actions, buttons);
			const confirm = pickConfirmButton(buttons);

			if (settings.debug) {
				log("openAlert (matched)", {
					key,
					title,
					isMessage,
					isEmbed,
					buttons: buttons.map((b) => b.variant ?? "(none)"),
					pickedConfirm: !!confirm,
				});
			}

			if (!confirm) return original(...args);
			confirm();
		});
	},
	stop() {
		unpatch?.();
		unpatch = undefined;
	},
	SettingsComponent: Settings,
});
