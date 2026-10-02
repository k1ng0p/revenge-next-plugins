const MAX_DEPTH = 3;
const IDLE_MESSAGE = /by yourself in this call/i;

export default plugin({
	start({ cleanup }) {
		const { onAnyFluxEventDispatched } = revenge.discord.flux;
		const { Logger } = revenge.discord.common.logger;
		const log = new Logger("DisableCallIdle");

		cleanup(
			onAnyFluxEventDispatched((p: any) => {
				if (p?.type === "MESSAGE_CREATE" && IDLE_MESSAGE.test(String(p.message?.content ?? ""))) return;
				if (p?.type !== "VOICE_CHANNEL_SELECT" || p.channelId) return p;

				const frames = (new Error().stack ?? "").split("\n").slice(1);
				const at = frames.findIndex((f) => /\bat disconnect \(/.test(f));
				const depth = at < 0 ? -1 : frames.length - at - 1;
				const block = at >= 0 && depth <= MAX_DEPTH;

				log.log(`leave ${block ? "blocked" : "passed"} depth=${depth}`);
				return block ? undefined : p;
			}),
		);
	},
});
